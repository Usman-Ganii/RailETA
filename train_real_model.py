import pandas as pd
import joblib

from sklearn.model_selection import train_test_split
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import (
    mean_absolute_error,
    root_mean_squared_error,
    r2_score
)


# ==========================================
# FILES
# ==========================================

DATA_FILE = "data/processed_train_data.csv"
MODEL_FILE = "model/eta_model.pkl"


# ==========================================
# LOAD PROCESSED DATA
# ==========================================

df = pd.read_csv(DATA_FILE)

print("Dataset loaded successfully!")

print(
    "Rows:",
    len(df)
)

print("\nColumns:")

print(
    df.columns.tolist()
)


# ==========================================
# FEATURES AND TARGET
# ==========================================

FEATURES = [
    "current_delay",
    "distance_remaining",
    "stops_remaining",
    "historical_avg_delay"
]

TARGET = "additional_delay"


X = df[FEATURES]

y = df[TARGET]


# ==========================================
# TRAIN / TEST SPLIT
# ==========================================

X_train, X_test, y_train, y_test = (
    train_test_split(
        X,
        y,
        test_size=0.2,
        random_state=42
    )
)


print("\nTraining rows:")

print(
    len(X_train)
)

print("Testing rows:")

print(
    len(X_test)
)


# ==========================================
# RANDOM FOREST MODEL
# ==========================================

model = RandomForestRegressor(
    n_estimators=300,
    random_state=42,
    min_samples_leaf=2,
    max_features=1.0,
    n_jobs=-1
)


print("\nTraining Random Forest...")

model.fit(
    X_train,
    y_train
)


# ==========================================
# PREDICTION
# ==========================================

predictions = model.predict(
    X_test
)


# ==========================================
# MODEL EVALUATION
# ==========================================

mae = mean_absolute_error(
    y_test,
    predictions
)

rmse = root_mean_squared_error(
    y_test,
    predictions
)

r2 = r2_score(
    y_test,
    predictions
)


# ==========================================
# PRINT MODEL PERFORMANCE
# ==========================================

print("\n================================")
print("MODEL EVALUATION")
print("================================")

print(
    "MAE:",
    round(mae, 2),
    "minutes"
)

print(
    "RMSE:",
    round(rmse, 2),
    "minutes"
)

print(
    "R²:",
    round(r2, 4)
)


# ==========================================
# FEATURE IMPORTANCE
# ==========================================

feature_importance = dict(
    zip(
        FEATURES,
        model.feature_importances_
    )
)


print("\nFeature Importance:")

for feature, importance in (
    feature_importance.items()
):

    print(
        feature,
        ":",
        round(
            importance * 100,
            2
        ),
        "%"
    )


# ==========================================
# SAVE MODEL
# ==========================================

joblib.dump(
    model,
    MODEL_FILE
)


# ==========================================
# FINAL OUTPUT
# ==========================================

print("\n================================")
print("MODEL TRAINING COMPLETED")
print("================================")

print(
    "Model saved to:"
)

print(
    MODEL_FILE
)

print("\nModel configuration:")

print(
    "Algorithm: Random Forest Regressor"
)

print(
    "Estimators:",
    model.n_estimators
)

print(
    "Features:",
    len(FEATURES)
)

print(
    "Training rows:",
    len(X_train)
)

print(
    "Testing rows:",
    len(X_test)
)