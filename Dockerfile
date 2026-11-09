FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1
WORKDIR /app

COPY index.html styles.css script.js server.py ./
# Data is never baked into the image; mount a volume at /app/data to keep it.
RUN mkdir -p /app/data
VOLUME /app/data

EXPOSE 8000

CMD ["python3", "server.py"]
