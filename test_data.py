import joblib
import pandas as pd
from sklearn.metrics import mean_absolute_error, root_mean_squared_error

from sklearn.model_selection import train_test_split
from sklearn.ensemble import RandomForestRegressor


# Load dataset
df = pd.read_csv("data/train_data.csv")


# Input features
X = df[
    [
        "current_delay",
        "distance_remaining",
        "stops_remaining",
        "historical_avg_delay"
    ]
]


# Target
y = df["additional_delay"]


# Split data
X_train, X_test, y_train, y_test = train_test_split(
    X,
    y,
    test_size=0.2,
    random_state=42
)


# Create Random Forest model
model = RandomForestRegressor(
    n_estimators=100,
    random_state=42
)


# Train the model
model.fit(X_train, y_train)


print("Model trained successfully!")

model.fit(X_train, y_train)

# Make predictions on test data
predictions = model.predict(X_test)

print("\n----- PREDICTIONS -----")

for actual, predicted in zip(y_test, predictions):
    print(
        "Actual:",
        actual,
        "minutes | Predicted:",
        round(predicted, 2),
        "minutes"
    )

    # Calculate model performance
mae = mean_absolute_error(y_test, predictions)
rmse = root_mean_squared_error(y_test, predictions)

print("\n----- MODEL PERFORMANCE -----")
print("MAE:", round(mae, 2), "minutes")
print("RMSE:", round(rmse, 2), "minutes")

joblib.dump(model, "model/eta_model.pkl")

print("\nModel saved successfully!")