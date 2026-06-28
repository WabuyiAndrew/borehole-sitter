FROM python:3.10-slim

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY app /app/app
COPY models /app/models

ENV MODEL_PATH=/app/models/awoja_deployment_bundle.joblib
ENV CORS_ORIGINS=http://localhost,http://localhost:3000,http://localhost:4173,http://localhost:5173,http://127.0.0.1,http://127.0.0.1:3000,http://127.0.0.1:4173,http://127.0.0.1:5173,capacitor://localhost,ionic://localhost
ENV CORS_ORIGIN_REGEX=https://.*\.onrender\.com
ENV CORS_ALLOW_ALL=false

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
