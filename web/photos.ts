// Photos for the fictional venues: real restaurant photographs from Unsplash (free to use under the Unsplash
// License). The venues are invented, so a photo shows what a room like it looks like, not a real restaurant.
// They are served from this site (docs/img/v, fetched once by scripts/fetch-media.mjs): a small and a large size.
const U = (id: string, w = 640) => `img/v/${id}-${w <= 520 ? "s" : "l"}.jpg`;

/** One interior per venue, in the order of data/seed.ts NAMES (30 venues). */
const HERO = [
  "photo-1517248135467-4c7edcad34c4", "photo-1667388969250-1c7220bf3f37", "photo-1776763255189-3c8237aec808", "photo-1786209677036-1580ca1b280d",
  "photo-1583354608715-177553a4035e", "photo-1559339352-11d035aa65de", "photo-1783447036642-90a65ff85a0f", "photo-1765021097487-6da56c1ce412",
  "photo-1636405189493-181ecf851006", "photo-1729394405518-eaf2a0203aa7", "photo-1765360773028-6affda725695", "photo-1538333581680-29dd4752ddf2",
  "photo-1651977560863-ca39bfa5176f", "photo-1538334421852-687c439c92f4", "photo-1667388968964-4aa652df0a9b", "photo-1555396273-367ea4eb4db5",
  "photo-1772119044027-04e80adeda6b", "photo-1579027989536-b7b1f875659b", "photo-1784729892012-dd068242d91b", "photo-1569096651661-820d0de8b4ab",
  "photo-1690983325551-b922137727be", "photo-1636405188904-bc706f07aa37", "photo-1414235077428-338989a2e8c0", "photo-1606660023296-81d67734170a",
  "photo-1768405942810-cc498a399951", "photo-1621275471769-e6aa344546d5", "photo-1485182708500-e8f1f318ba72", "photo-1521917441209-e886f0404a7b",
  "photo-1720701247839-9b8433398385", "photo-1651977560784-488c2b872df1",
];
const ROOMS: Record<string, string[]> = {
  "Wine Cellar": ["photo-1724882207681-9e7e8c3dd45c", "photo-1562663729-4971d6802f4a", "photo-1738544475560-0683270451bd", "photo-1633119985201-7fb2c6eb1aec", "photo-1765850258613-9e671f59a9ad", "photo-1604256792183-5d179890f31b"],
  "The Library": ["photo-1574966739987-65e38db0f7ce", "photo-1484156818044-c040038b0719", "photo-1606660023296-81d67734170a", "photo-1517870662726-c1d98ee36250"],
  "Chef's Room": ["photo-1531856396526-a0c8d7bd628b", "photo-1578758391363-1ea37a77ec87", "photo-1625584733117-23a842650ff1", "photo-1625668751669-65ceebd81e34"],
  "Garden Room": ["photo-1493246318656-5bfd4cfb29b8", "photo-1622758235004-51977c5863f5", "photo-1756397391675-dce7c5faf9cc", "photo-1613274554329-70f997f5789f"],
};
const num = (id: string) => Number(id.replace(/\D/g, "")) || 0;
export const venuePhoto = (venueId: string, w?: number, _h?: number) => U(HERO[(num(venueId) - 1 + HERO.length) % HERO.length], w);
export function roomPhoto(venueId: string, roomName: string, w?: number, _h?: number) {
  const set = ROOMS[roomName]; return set ? U(set[num(venueId) % set.length], w) : venuePhoto(venueId, w);
}
export const HERO_BG = U("photo-1786209677036-1580ca1b280d", 1800);
/** Every photo id, for scripts/fetch-media.mjs. */
export const ALL_PHOTOS = [...new Set([...HERO, ...Object.values(ROOMS).flat(), "photo-1786209677036-1580ca1b280d"])];
export const PHOTO_CREDIT = "Photos: Unsplash";
