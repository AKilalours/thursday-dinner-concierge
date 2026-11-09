"""Streamlit entry point for the Thursday Dinner Concierge.

The product is TypeScript: the agent, tools, policy, store and evals in src/ and evals/ are bundled
by `npm run build:web` into docs/app.js. This file only hosts that same build inside Streamlit,
so the Streamlit app and the GitHub Pages site are always the identical, tested code.
"""
from pathlib import Path

import streamlit as st
import streamlit.components.v1 as components

DOCS = Path(__file__).parent / "docs"
PAGES_URL = "https://akilalours.github.io/thursday-dinner-concierge/"
REPO_URL = "https://github.com/AKilalours/thursday-dinner-concierge"

st.set_page_config(page_title="Thursday Dinner Concierge", page_icon="🍽️", layout="wide", initial_sidebar_state="collapsed")
st.markdown(
    """<style>
    header[data-testid="stHeader"], footer, #MainMenu {display: none;}
    .block-container {padding: 0.6rem 0.6rem 0 0.6rem; max-width: 100%;}
    .tdc-bar {display:flex; justify-content:space-between; align-items:center; font: 500 13px Inter, system-ui, sans-serif;
              color:#7a6a5d; padding: 0 6px 6px;}
    .tdc-bar a {color:#7b1e3a; font-weight:600; text-decoration:none; margin-left:14px;}
    </style>""",
    unsafe_allow_html=True,
)
st.markdown(
    f'<div class="tdc-bar"><span>Thursday Dinner Concierge · built for Ande · independent project, fictional data</span>'
    f'<span><a href="{PAGES_URL}" target="_blank">Open full screen ↗</a><a href="{REPO_URL}" target="_blank">Code ↗</a></span></div>',
    unsafe_allow_html=True,
)


@st.cache_resource
def page() -> str:
    """docs/index.html with docs/app.js inlined, so it runs inside Streamlit's component frame."""
    html = (DOCS / "index.html").read_text(encoding="utf-8")
    js = (DOCS / "app.js").read_text(encoding="utf-8").replace("</script", "<\\/script")
    return html.replace('<script type="module" src="./app.js"></script>', f'<script type="module">{js}</script>')


components.html(page(), height=920, scrolling=True)
