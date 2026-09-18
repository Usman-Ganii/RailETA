import pandas as pd
import joblib

from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_absolute_error, root_mean_squared_error

# Load the NEWLY SAVED model
model = joblib.load("model/eta_model.pkl")

# Load processed dataset
df = pd.read_csv("data/processed_train_data.csv")

X = df[
    [
        "current_delay",
        "distance_remaining",
        "stops_remaining",
        "historical_avg_delay"
    ]
]

y = df["additional_delay"]

# Same split used during training
X_train, X_test, y_train, y_test = train_test_split(
    X,
    y,
    test_size=0.2,
    random_state=42
)

# Prediction using saved model
predictions = model.predict(X_test)

mae = mean_absolute_error(y_test, predictions)
rmse = root_mean_squared_error(y_test, predictions)

print("================================")
print("SAVED MODEL VERIFICATION")
print("================================")

print("Model:", type(model).__name__)
print("Trees:", model.n_estimators)
print("Features:", model.n_features_in_)

print("\nMAE:", round(mae, 2), "minutes")
print("RMSE:", round(rmse, 2), "minutes")

print("\nModel prediction test successful!")