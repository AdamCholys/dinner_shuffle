FROM python:3.12-slim

WORKDIR /app

COPY index.html styles.css script.js server.py ./
COPY data ./data

EXPOSE 8000

CMD ["python3", "server.py"]