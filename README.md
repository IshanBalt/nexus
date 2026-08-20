# Nexus AI

An AI agent that reasons about the hidden dependencies of the physical world.

Nexus builds a knowledge graph of the infrastructure around any point in the United States, then lets an LLM traverse it to answer questions no map can: *what depends on this bridge?*, *if this substation fails, what breaks next?*, *what is the weakest point in this county?*

The map is context. The reasoning is the product.

---

## Quick start

```bash
cp .env.local.example .env.local   # add GROQ_API_KEY and MIREYE_API_TOKEN
npm install
npm run dev
```

Open http://localhost:3000, click anywhere on the map, and ask a question.

Run the graph engine's self-check:

```bash
npm test
```

---

## How it works

## The standing watch

Nexus does not wait to be asked. Every half hour, with nobody watching, it sweeps the **59 structures it could locate** from the NTSB's list of bridges needing a vessel-collision assessment, pulls live National Weather Service alerts and USGS river readings for each, and decides which ones a person should hear about today. It writes about those. The findings are committed to this repository as a dated artifact, so every claim about what the world looked like at 16:43 on a Thursday can be checked against the run that made it.

Triage is deterministic arithmetic, not a model. Fifty-nine federal structures ranked by an LLM would drift between runs and could not be audited; a documented sum over measured readings can be disagreed with by anyone who reads it. Every signal carries the weight it contributed, so the score can be recomputed from what the panel shows. The model is asked only to write, and only about what triage already selected — which is the division of labour that makes the answer trustworthy: judgment where it is checkable, prose where it is useful.

The report names 68 spans. Three structures have no coordinate here, and say so: I-610 and Beltway 8 cross the Houston Ship Channel on ways whose centroids sit a mile off the span, and nothing in OpenStreetMap carries the GulfGate name. A federal finding attached to the wrong bridge is worse than a bridge left out.

---

**1 — Resolve.** A click, an address, a coordinate pair, or a place name resolves through Mireye `/v1/lookup`, falling back to Nominatim for landmarks Mireye does not index.

**2 — Federate.** Four data pulls run in parallel: OpenStreetMap infrastructure via Overpass, plus Mireye's `lookup`, `utilities`, and `natural_hazard` presets. Every failure is captured rather than swallowed.

**3 — Build the graph.** Assets become nodes; a rule engine infers the edges between them. This is the part that is not a map:

| Rule | Inference |
|---|---|
| `R1` | Lifeline facilities depend on their nearest arterial road — weighted **0.85 when it is the only one in range, 0.45 when alternatives exist**. Redundancy is the difference between an inconvenience and an isolation. |
| `R2` | Bridges carry roads and cross watercourses — the structure is the failure point, the road is a separate node. |
| `R3` | Facilities draw from their nearest substation. Hospitals are weighted lower (0.55) because licensed facilities carry standby generation. |
| `R4` | Substations depend on transmission lines within 1.2 km, and only weakly (0.4) on the nearest plant — grids are meshed. |
| `R6` | Water treatment serves facilities in range; electric pump stations have no gravity fallback. |
| `R7` | Watercourse–road intersections are computed geometrically, not by proximity — these are where roads overtop first. |
| `R8` | Flood exposure, flagged only when the query point falls in a mapped FEMA zone. |
| `R9` | Everything terminates in population, which is what makes a cascade matter. |
| `R10` | Vessel-strike exposure. A bridge matched against the 68 spans the NTSB named in MIR-25-10 — designed before AASHTO's vessel-collision guidance, spanning a navigable channel, no assessment on record — gains a `THREATENS` edge from the water it crosses. Matching is gated on state and refuses single-word substrings, because a false positive here is a federal claim about a real structure. |

Every edge carries a plain-language rationale and a confidence level, and both travel with it into the agent's answer.

**4 — Reason.** The agent (Groq, `openai/gpt-oss-120b`) gets eight tools over the graph: `survey_area`, `find_nodes`, `what_depends_on`, `what_this_needs`, `simulate_failure`, `weakest_points`, `site_context`, `ask_mireye`. It is instructed never to list data — observe, infer, explain the consequence.

**5 — Look at the water.** On any bridge, *Check live vessel traffic* opens a short subscription to aisstream.io and returns the ships broadcasting under the structure right now — name, class, length, draught, speed, destination. It runs outside the agent's tool budget and is handed to the model as context, so one answer can carry both halves: the cascade on land and the 229 m loaded ship approaching the pier. On a bridge the NTSB flagged, *Generate exposure brief* asks for exactly that, in the form an owner or an underwriter would want it.

**6 — Watch.** *Watch this bridge* leaves the agent looking at one structure: a vessel check every minute, and when something over 100 m comes past under way, it raises the approach and runs the cascade for that structure without being asked — so the consequence of losing the span is already on screen next to the ship that could take it. A watch that can't see says so; a quiet watch and a blind one never look the same. The loop runs in the browser tab, because a serverless function that lives twenty seconds has nowhere to keep a subscription.

**7 — Simulate.** Breadth-first propagation with severity decay: each hop multiplies by the edge weight, so a sole-access road carries impact far while a redundant one dies out. Onset timing is modelled per dependency type — a severed route fails instantly, a hospital on generator fuel degrades at ~72 hours, water distribution drains at ~12. Scrub the bottom timeline to watch the cascade spread.

---

## Honesty model

The system is built to be trusted by someone who will check it.

- **Every source is cited** with a working URL and a confidence level, shown in the evidence panel.
- **Inferences are labelled as inferences.** Utility service territories are not public, so grid edges are proximity-derived and say so in the rationale text the agent reads.
- **Gaps are surfaced, not hidden.** A dataset with no coverage appears in the evidence panel with the reason. "No mapped substation here" is a finding, not silence.
- **Numbers come from tools**, never from the model. Population splits state their even-split assumption inline.

---

## Stack

Next.js 16 · TypeScript · Tailwind 4 · MapLibre GL · Groq (`openai/gpt-oss-120b`)

The graph is a few hundred nodes built fresh per query and thrown away, so it lives in plain objects — no graph database, no vector store, no task queue, no container orchestration. Parallelism is `Promise.allSettled`; caching is two `Map`s with TTLs. Both are marked with `ponytail:` comments naming the ceiling and the upgrade path.

## Data sources

Mireye (terrain, flood, soil, utilities, parcel, county market) · OpenStreetMap / Overpass · [NWS active alerts](https://api.weather.gov) · [USGS instantaneous values](https://waterservices.usgs.gov/nwis/iv/) · [NTSB MIR-25-10](https://www.ntsb.gov/investigations/AccidentReports/Reports/MIR2510.pdf) (bridges needing a vessel-strike assessment) · [aisstream.io](https://aisstream.io) (live AIS) · FEMA NFHL and USGS elevation via Mireye · Nominatim · CARTO basemaps · Esri World Imagery and Hillshade.

`AISSTREAM_API_KEY` is optional. Without it the vessel check reports that it is not configured, and nothing else changes.
