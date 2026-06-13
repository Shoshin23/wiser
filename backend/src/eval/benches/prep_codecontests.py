"""Stream a small CodeContests subset to a local jsonl (no full-dataset download).

Run:  uv run --no-project --with datasets python prep_codecontests.py [N]
Writes: eval-data/codecontests/pilot.jsonl  with records:
  { id, description, reference (a correct PYTHON3 solution), tests:[{input,output}] }
"""
import json
import os
import sys

from datasets import load_dataset

N = int(sys.argv[1]) if len(sys.argv) > 1 else 12
MIN_RATING = int(sys.argv[2]) if len(sys.argv) > 2 else 1500  # Codeforces rating floor
PY3 = 3  # CodeContests language enum: 0 unknown,1 py2,2 cpp,3 py3,4 java
HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "..", "..", "..", "eval-data", "codecontests")
os.makedirs(OUT_DIR, exist_ok=True)
OUT = os.path.join(OUT_DIR, "pilot.jsonl")

ds = load_dataset("deepmind/code_contests", split="test", streaming=True)

picked = []
for ex in ds:
    # Keep only harder problems (capable solver should still sometimes fail).
    rating = ex.get("cf_rating") or 0
    if rating < MIN_RATING:
        continue
    sols = ex.get("solutions") or {}
    langs = sols.get("language") or []
    bodies = sols.get("solution") or []
    py3 = [b for l, b in zip(langs, bodies) if l == PY3]
    if not py3:
        continue
    # Gather concrete test cases (public + private), capped and size-limited.
    tests = []
    for grp in ("public_tests", "private_tests"):
        g = ex.get(grp) or {}
        for i, o in zip(g.get("input", []), g.get("output", [])):
            if len(i) > 8000 or len(o) > 8000:
                continue
            tests.append({"input": i, "output": o})
    if len(tests) < 2:
        continue
    picked.append(
        {
            "id": ex["name"][:80],
            "rating": rating,
            "description": ex["description"],
            "reference": py3[0],
            "tests": tests[:12],
        }
    )
    if len(picked) >= N:
        break

with open(OUT, "w") as f:
    for r in picked:
        f.write(json.dumps(r) + "\n")
print(f"wrote {len(picked)} problems -> {OUT}")
