# Dinner Shuffle

A small browser app for planning dinners for a month.

## What it does

- lets you enter a list of possible dinners
- stores your dinner list in a shared JSON file on the server
- stores the latest generated monthly plan in a shared JSON file on the server
- generates a monthly plan where one dinner is assigned to two consecutive days
- can keep dinners starting with `Zupa` spaced apart by a configurable number of non-zupa meals
- reshuffles the plan whenever you regenerate it
- keeps the saved dinners available for other people using the same app instance
- restores the latest generated plan for every user who opens the app

## Run it

Run the included server so the app can share saved dinners across browsers and sessions.

Example:

```bash
cd /home/gazel/vscode/obiad_shuffle
python3 server.py
```

Then open `http://localhost:8000`.

## Run with Docker

Build and start the app with Docker Compose:

```bash
cd /home/gazel/vscode/obiad_shuffle
docker compose up --build
```

Then open `http://localhost:8080`.

The compose setup mounts `./data` into the container, so saved dinners and the latest plan stay on the host machine between container restarts.

## Run on local k3s

The app can run on a local k3s cluster with the manifest in `k8s/dinner-shuffle.yaml`.

### 1. Build the image locally

```bash
cd /home/gazel/vscode/obiad_shuffle
docker compose build
```

The compose file tags the image as `dinner-shuffle:latest`, which matches the k3s manifest.

### 2. Import the image into k3s

If your k3s uses the default containerd runtime, import the locally built image:

```bash
docker save dinner-shuffle:latest | sudo k3s ctr images import -
```

### 3. Deploy to the cluster

```bash
kubectl apply -f k8s/dinner-shuffle.yaml
kubectl rollout restart deployment/dinner-shuffle -n dinner-shuffle
```

### 4. Open the app

By default the service is exposed as a `NodePort` on port `30080`:

```bash
kubectl get nodes -o wide
```

Open `http://<node-ip>:30080`.

For a single-node local setup, `http://localhost:30080` usually works.

### 5. Check status

```bash
kubectl get pods -n dinner-shuffle
kubectl get svc -n dinner-shuffle
kubectl logs -n dinner-shuffle deploy/dinner-shuffle
```

The deployment uses a `PersistentVolumeClaim` backed by the k3s `local-path` storage class, so `data/dinners.json` and `data/latest_plan.json` remain persistent across pod restarts.

Saved dinners are written to `data/dinners.json`, and the latest generated plan is written to `data/latest_plan.json`. If multiple people open the app from the same server, they will all use the same dinner list and see the latest saved monthly proposal.