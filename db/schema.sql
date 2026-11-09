-- The safety rules live here, not in a prompt. The agent's database role can propose; it cannot
-- approve, cannot book or pay without an approved proposal, cannot pay anyone but the venue's payee
-- on file, cannot double-book a room, and cannot rewrite history.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS venues (
  id text PRIMARY KEY,
  name text NOT NULL,
  payee_id text NOT NULL UNIQUE,
  data jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id text PRIMARY KEY,
  venue_id text NOT NULL REFERENCES venues(id),
  private boolean NOT NULL,
  listed_capacity int NOT NULL CHECK (listed_capacity > 0)
);

CREATE TABLE IF NOT EXISTS runs (
  id text PRIMARY KEY,
  actor_id text NOT NULL,
  principal_id text NOT NULL,
  request_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Every step the concierge takes, in order. A crashed run resumes from its last step.
CREATE TABLE IF NOT EXISTS run_steps (
  run_id text NOT NULL REFERENCES runs(id),
  seq int NOT NULL,
  agent text NOT NULL,
  kind text NOT NULL,
  detail jsonb NOT NULL,
  PRIMARY KEY (run_id, seq)
);

-- A retried tool call with the same key returns the first result instead of acting twice.
CREATE TABLE IF NOT EXISTS tool_calls (
  idempotency_key text PRIMARY KEY,
  run_id text NOT NULL REFERENCES runs(id),
  tool text NOT NULL,
  actor_id text NOT NULL,
  principal_id text NOT NULL,
  input jsonb NOT NULL,
  output jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS proposals (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES runs(id),
  kind text NOT NULL CHECK (kind IN ('book', 'pay_deposit', 'amend', 'cancel')),
  replaces_booking_id text,
  actor_id text NOT NULL,
  principal_id text NOT NULL,
  venue_id text NOT NULL REFERENCES venues(id),
  room_id text NOT NULL REFERENCES rooms(id),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
  party_size int NOT NULL CHECK (party_size > 0),
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  payee_id text,
  required_roles text[] NOT NULL CHECK (cardinality(required_roles) >= 1),
  approved_roles text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired','executed')),
  summary text NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  proposal_id text NOT NULL REFERENCES proposals(id),
  role text NOT NULL,
  user_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approve', 'reject')),
  decided_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (proposal_id, role)
);

-- A proposal is approved only when every required role has approved, and never by the agent.
CREATE OR REPLACE FUNCTION apply_approval() RETURNS trigger AS $$
DECLARE p proposals%ROWTYPE;
BEGIN
  SELECT * INTO p FROM proposals WHERE id = NEW.proposal_id FOR UPDATE;
  IF p.status <> 'pending' THEN
    RAISE EXCEPTION 'proposal % is %, not pending', p.id, p.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.user_id = 'agent' THEN
    RAISE EXCEPTION 'the agent cannot approve its own proposal' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT (NEW.role = ANY (p.required_roles)) THEN
    RAISE EXCEPTION 'role % is not required for proposal %', NEW.role, p.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.decision = 'reject' THEN
    UPDATE proposals SET status = 'rejected' WHERE id = p.id;
  ELSE
    UPDATE proposals SET approved_roles = array_append(approved_roles, NEW.role),
      status = CASE WHEN required_roles <@ array_append(approved_roles, NEW.role) THEN 'approved' ELSE 'pending' END
    WHERE id = p.id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
DROP TRIGGER IF EXISTS approvals_apply ON approvals;
CREATE TRIGGER approvals_apply AFTER INSERT ON approvals FOR EACH ROW EXECUTE FUNCTION apply_approval();

CREATE TABLE IF NOT EXISTS bookings (
  id text PRIMARY KEY,
  proposal_id text NOT NULL UNIQUE REFERENCES proposals(id),
  venue_id text NOT NULL REFERENCES venues(id),
  room_id text NOT NULL REFERENCES rooms(id),
  during tstzrange NOT NULL,
  party_size int NOT NULL,
  status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
  EXCLUDE USING gist (room_id WITH =, during WITH &&) WHERE (status = 'confirmed')
);

-- A booking must match an approved, unexpired 'book' proposal exactly.
CREATE OR REPLACE FUNCTION check_booking() RETURNS trigger AS $$
DECLARE p proposals%ROWTYPE;
BEGIN
  SELECT * INTO p FROM proposals WHERE id = NEW.proposal_id FOR UPDATE;
  IF p.kind NOT IN ('book', 'amend') OR p.status <> 'approved' THEN
    RAISE EXCEPTION 'booking needs an approved book proposal (got % %)', p.kind, p.status USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p.expires_at < coalesce(nullif(current_setting('app.now', true), '')::timestamptz, now()) THEN
    RAISE EXCEPTION 'proposal % expired', p.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.venue_id <> p.venue_id OR NEW.room_id <> p.room_id OR NEW.party_size <> p.party_size
     OR NEW.during <> tstzrange(p.starts_at, p.ends_at) THEN
    RAISE EXCEPTION 'booking does not match what the booker approved' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE proposals SET status = 'executed' WHERE id = p.id;
  RETURN NEW;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
DROP TRIGGER IF EXISTS bookings_check ON bookings;
CREATE TRIGGER bookings_check BEFORE INSERT ON bookings FOR EACH ROW EXECUTE FUNCTION check_booking();

-- Changes after booking. An amendment cancels the old booking and inserts the new one in one transaction,
-- so a failed change can never leave the booker with nothing. A cancellation needs its own approval too.
CREATE OR REPLACE FUNCTION amend_booking(p_proposal text, p_new_booking text) RETURNS text AS $$
DECLARE p proposals%ROWTYPE; old bookings%ROWTYPE;
BEGIN
  SELECT * INTO p FROM proposals WHERE id = p_proposal FOR UPDATE;
  IF p.kind <> 'amend' OR p.status <> 'approved' THEN
    RAISE EXCEPTION 'amendment needs an approved amend proposal' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO old FROM bookings WHERE id = p.replaces_booking_id FOR UPDATE;
  IF old.id IS NULL OR old.status <> 'confirmed' THEN
    RAISE EXCEPTION 'amendment must replace a confirmed booking' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE bookings SET status = 'cancelled' WHERE id = old.id;
  INSERT INTO bookings (id, proposal_id, venue_id, room_id, during, party_size)
    VALUES (p_new_booking, p.id, p.venue_id, p.room_id, tstzrange(p.starts_at, p.ends_at), p.party_size);
  RETURN p_new_booking;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION cancel_booking(p_proposal text) RETURNS text AS $$
DECLARE p proposals%ROWTYPE; b bookings%ROWTYPE;
BEGIN
  SELECT * INTO p FROM proposals WHERE id = p_proposal FOR UPDATE;
  IF p.kind <> 'cancel' OR p.status <> 'approved' THEN
    RAISE EXCEPTION 'cancellation needs an approved cancel proposal' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO b FROM bookings WHERE id = p.replaces_booking_id FOR UPDATE;
  IF b.id IS NULL OR b.status <> 'confirmed' THEN
    RAISE EXCEPTION 'cancellation must target a confirmed booking' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE bookings SET status = 'cancelled' WHERE id = b.id;
  UPDATE proposals SET status = 'executed' WHERE id = p.id;
  RETURN b.id;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TABLE IF NOT EXISTS payments (
  id text PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  proposal_id text NOT NULL UNIQUE REFERENCES proposals(id),
  booking_id text NOT NULL REFERENCES bookings(id),
  payee_id text NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0)
);

-- Money goes only to the payee on file for the booked venue, for at most the approved amount.
CREATE OR REPLACE FUNCTION check_payment() RETURNS trigger AS $$
DECLARE p proposals%ROWTYPE; v venues%ROWTYPE; b bookings%ROWTYPE;
BEGIN
  SELECT * INTO p FROM proposals WHERE id = NEW.proposal_id FOR UPDATE;
  SELECT * INTO b FROM bookings WHERE id = NEW.booking_id;
  SELECT * INTO v FROM venues WHERE id = b.venue_id;
  IF p.kind <> 'pay_deposit' OR p.status <> 'approved' THEN
    RAISE EXCEPTION 'payment needs an approved pay_deposit proposal' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.payee_id <> v.payee_id OR p.payee_id IS DISTINCT FROM v.payee_id THEN
    RAISE EXCEPTION 'payee % is not the payee on file for %', NEW.payee_id, v.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.amount_cents > p.amount_cents THEN
    RAISE EXCEPTION 'payment exceeds the approved amount' USING ERRCODE = 'check_violation';
  END IF;
  IF b.venue_id <> p.venue_id OR b.status <> 'confirmed' THEN
    RAISE EXCEPTION 'payment must be for a confirmed booking at the approved venue' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE proposals SET status = 'executed' WHERE id = p.id;
  RETURN NEW;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
DROP TRIGGER IF EXISTS payments_check ON payments;
CREATE TRIGGER payments_check BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION check_payment();

-- Facts learned from venue conversations: "the Wine Cellar really seats 14", "replies within an hour".
CREATE TABLE IF NOT EXISTS venue_facts (
  venue_id text NOT NULL REFERENCES venues(id),
  room_id text,
  kind text NOT NULL,
  value jsonb NOT NULL,
  confidence real NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  source_message_id text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS venue_facts_venue ON venue_facts (venue_id, kind);

-- What the agent remembers about people and companies. Private memories are visible to their owner only,
-- enforced by row-level security on the app role, so a bug in the agent cannot leak them.
CREATE TABLE IF NOT EXISTS memories (
  id bigserial PRIMARY KEY,
  company_id text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('company', 'private')),
  owner_user_id text NOT NULL,
  subject text NOT NULL,
  fact text NOT NULL,
  source text NOT NULL
);
ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS memories_visible ON memories;
CREATE POLICY memories_visible ON memories
  USING (company_id = current_setting('app.company_id', true)
         AND (scope = 'company' OR owner_user_id = current_setting('app.user_id', true)))
  WITH CHECK (company_id = current_setting('app.company_id', true)
         AND owner_user_id = current_setting('app.user_id', true));

CREATE TABLE IF NOT EXISTS audit_log (
  id bigserial PRIMARY KEY,
  run_id text,
  actor_id text NOT NULL,
  action text NOT NULL,
  detail jsonb NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION audit_is_append_only() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only' USING ERRCODE = 'insufficient_privilege'; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_no_change ON audit_log;
CREATE TRIGGER audit_no_change BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_is_append_only();

-- Two roles. The agent proposes, books and pays (only through the checks above). Approvals come from
-- the booker-facing app under a different role, so even a fully compromised agent cannot approve.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ande_agent') THEN CREATE ROLE ande_agent LOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ande_approver') THEN CREATE ROLE ande_approver LOGIN; END IF;
END $$;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA public TO ande_agent;
REVOKE INSERT ON approvals FROM ande_agent;
GRANT UPDATE (status) ON bookings TO ande_agent;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ande_agent;
GRANT SELECT ON proposals, approvals TO ande_approver;
GRANT INSERT ON approvals TO ande_approver;
