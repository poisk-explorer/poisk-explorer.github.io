# POISK Explorer

[Explore the dataset](https://poisk-explorer.github.io/) — search patent-derived antibody sequences, targets, binding affinity, and supporting evidence in your browser.

Companion to [Can Folding Models Tell Binders from Bluffers? Evidence from POISK: The Patent-Derived Antibody Dataset](https://www.biorxiv.org/content/10.64898/2026.10.24.761513v1), by Daria Tupikina, Andrea Roncoli, Alexander Bujotzek, and Brennan Abanades. [Accepted at NeurIPS 2026](https://neurips.cc/virtual/2026/poster/139745).

## Citation

```bibtex
@article{tupikina2026poisk,
  title = {Can Folding Models Tell Binders from Bluffers? Evidence from {POISK}: The Patent-Derived Antibody Dataset},
  author = {Tupikina, Daria and Roncoli, Andrea and Bujotzek, Alexander and Abanades, Brennan},
  journal = {bioRxiv},
  year = {2026},
  doi = {10.64898/2026.10.24.761513},
  url = {https://www.biorxiv.org/content/10.64898/2026.10.24.761513v1},
  note = {Accepted at NeurIPS 2026}
}
```

The dataset is CC BY 4.0; the explorer code is [BSD-3-Clause](LICENSE).

## Run locally

Requires Python 3.10+; JavaScript tests also require Node.js 18+ (CI uses Python 3.13 and Node.js 24). No runtime packages are required.

```sh
python3 scripts/release.py --check
python3 -m unittest discover -s tests -p 'test_*.py'
node --test tests/*.test.mjs
python3 scripts/build.py
python3 -m http.server 8000 --directory dist
```

Open <http://localhost:8000/>. The first build downloads and verifies the pinned CSV (about 234 MB); subsequent builds reuse `.cache/`. Edit `web/` for site changes. GitHub Actions tests, builds, and publishes `dist/` to GitHub Pages on pushes to `main`.
