import requests

url = "http://127.0.0.1:5000/predict"

data = {
    "train_name":"Express Demo",
    "current_delay": 20,
    "distance_remaining": 160,
    "stops_remaining": 4,
    "historical_avg_delay": 20,
    "scheduled_arrival": "2026-09-06 18:30"
}

response = requests.post(url, json=data)

print("Status Code:", response.status_code)
print("Response:")
print(response.json())