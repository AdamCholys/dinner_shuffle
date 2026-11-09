# Dinner Shuffle

A small browser app for planning dinners for a month. No dependencies: a single Python
standard-library server plus static HTML/CSS/JS.

## What it does

- Polish interface for planning a month of dinners, one dinner per two consecutive days
- keeps dinners starting with `Zupa` spaced apart by a configurable number of other dinners
- Mon–Sun calendar view, plus a slot list where each slot can be changed, locked or re-rolled
- regenerating a plan keeps locked slots and only reshuffles the rest
- avoids last month's dinners when it can
- keeps a plan per month (history), shared by everyone using the same app instance
- refuses saves based on stale data, so two devices editing at once can't overwrite each other

## Run it

Pick one. Each starts with an empty dinner list; add dinners in the app.

### Python (3.8 or newer, nothing to install)

```bash
git clone https://github.com/AdamCholys/dinner_shuffle.git
cd dinner_shuffle
python3 server.py
```

Open `http://localhost:8000`. Other devices on the network can use `http://<this-computer's-IP>:8000`.

### Docker Compose

```bash
git clone https://github.com/AdamCholys/dinner_shuffle.git
cd dinner_shuffle
docker compose up -d --build
```

Open `http://localhost:8080`. Stop with `docker compose down`.

### Settings

Environment variables, all optional:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8000` (Compose: host port `8080`) | Port to listen on |
| `BIND_ADDRESS` | `0.0.0.0` | Use `127.0.0.1` to allow only this computer |
| `DATA_DIR` | `./data` | Where the data files are kept (Python only; Compose always uses `./data`) |

Example: `PORT=9000 python3 server.py`, or `PORT=9000 docker compose up -d`.

## Data

Everything is stored in `data/` (ignored by git):

- `dinners.json` - the dinner list
- `plans.json` - one plan per month

Back up by copying the folder. Both files carry a version number; the API answers
`409 Conflict` when a save is based on an older version. A `latest_plan.json` from the first
version of the app is imported into `plans.json` on start (the old file is left in place).

The app has no login. Run it only on a home network or behind something that restricts access.

## Run on k3s (single node)

The manifest in `k8s/dinner-shuffle.yaml` uses a locally built image and k3s's `local-path`
storage, so data survives pod restarts.

```bash
docker compose build
docker save dinner-shuffle:latest | sudo k3s ctr images import -
kubectl apply -f k8s/dinner-shuffle.yaml
kubectl -n dinner-shuffle rollout restart deployment/dinner-shuffle   # after rebuilding
```

Open `http://<node-ip>:30080`, or `http://dinner-shuffle.<node-ip>.nip.io` through the Traefik
ingress after replacing `192.168.1.104` in the manifest with your node's IP.

```bash
kubectl -n dinner-shuffle get pods
kubectl -n dinner-shuffle logs deploy/dinner-shuffle
```
