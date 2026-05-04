# Stage 1: Build the React frontend
FROM node:20-slim AS frontend-builder
WORKDIR /build
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: Production image
FROM python:3.11-slim

# System libraries required by docling / PyTorch / OpenCV
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    libgomp1 \
    libsm6 \
    libxext6 \
    libxrender1 \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies (separate layer for caching)
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend source
COPY backend/ ./

# Copy the built frontend
COPY --from=frontend-builder /build/dist ./frontend_dist/

# Persistent data directories (override with volumes at runtime)
RUN mkdir -p qdrant_storage storage

ENV PYTHONUNBUFFERED=1
ENV FRONTEND_DIST=/app/frontend_dist
ENV QDRANT_PATH=/app/qdrant_storage

EXPOSE 5000

CMD ["python", "api.py"]
