"""
RailETA - Model Evaluation

Evaluates the saved ETA model against a properly labelled
evaluation dataset.

Expected evaluation columns:

    current_delay
    distance_remaining
    stops_remaining
    historical_avg_delay
    additional_delay

The first four columns are model inputs.
The last column is the actual/ground-truth target.

IMPORTANT:
Do not calculate accuracy using the training CSV unless the CSV
contains a genuine ground-truth additional_delay value.
"""

import os
import warnings
import joblib
import pandas as pd
import numpy as np

from sklearn.metrics import (
    mean_absolute_error,
    mean_squared_error,
    r2_score
)


# ============================================================
# PATHS
# ============================================================

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

MODEL_PATH = os.path.join(
    BASE_DIR,
    "model",
    "eta_model.pkl"
)

# Recommended evaluation dataset.
#
# This is intentionally different from the normal training/history
# CSV so that we don't accidentally report training performance.
EVALUATION_DATA_PATH = os.path.join(
    BASE_DIR,
    "data",
    "model_evaluation.csv"
)


# ============================================================
# MODEL FEATURES
# ============================================================

FEATURES = [
    "current_delay",
    "distance_remaining",
    "stops_remaining",
    "historical_avg_delay"
]

TARGET = "additional_delay"


# ============================================================
# LOAD MODEL
# ============================================================

def load_model():
    """
    Load the saved Random Forest model.

    joblib is used because eta_model.pkl is a scikit-learn
    serialized model.
    """

    if not os.path.exists(MODEL_PATH):
        raise FileNotFoundError(
            f"Model file not found:\n{MODEL_PATH}"
        )

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        model = joblib.load(MODEL_PATH)

    return model


# ============================================================
# LOAD EVALUATION DATA
# ============================================================

def load_evaluation_data(path=EVALUATION_DATA_PATH):
    """
    Load a labelled evaluation dataset.

    The dataset must contain:

        current_delay
        distance_remaining
        stops_remaining
        historical_avg_delay
        additional_delay
    """

    if not os.path.exists(path):
        return None, (
            "No labelled evaluation dataset was found. "
            "Create data/model_evaluation.csv containing "
            "the four model features and actual additional_delay."
        )

    df = pd.read_csv(path)

    required_columns = FEATURES + [TARGET]

    missing_columns = [
        column
        for column in required_columns
        if column not in df.columns
    ]

    if missing_columns:
        return None, (
            "Evaluation dataset is missing required columns: "
            + ", ".join(missing_columns)
        )

    # Keep only required columns
    df = df[required_columns].copy()

    # Convert everything to numeric
    for column in required_columns:
        df[column] = pd.to_numeric(
            df[column],
            errors="coerce"
        )

    # Remove invalid rows
    before = len(df)

    df = df.dropna(
        subset=required_columns
    )

    removed = before - len(df)

    if len(df) == 0:
        return None, (
            "Evaluation dataset contains no valid numeric rows."
        )

    if removed > 0:
        print(
            f"Warning: removed {removed} invalid rows."
        )

    return df, None


# ============================================================
# EVALUATE MODEL
# ============================================================

def evaluate_model(
    evaluation_path=EVALUATION_DATA_PATH
):
    """
    Evaluate the saved ETA model.

    Returns a dictionary suitable for Flask JSON.
    """

    model = load_model()

    df, error = load_evaluation_data(
        evaluation_path
    )

    if error:
        return {
            "success": False,
            "available": False,
            "message": error
        }

    X = df[FEATURES]
    y_actual = df[TARGET]

    # Model predictions
    y_pred = model.predict(X)

    # Metrics
    mae = mean_absolute_error(
        y_actual,
        y_pred
    )

    rmse = np.sqrt(
        mean_squared_error(
            y_actual,
            y_pred
        )
    )

    r2 = r2_score(
        y_actual,
        y_pred
    )

    # --------------------------------------------------------
    # Prediction records for the dashboard
    # --------------------------------------------------------

    comparison = []

    for actual, predicted in zip(
        y_actual.tolist(),
        y_pred.tolist()
    ):
        comparison.append({
            "actual": round(float(actual), 2),
            "predicted": round(float(predicted), 2)
        })

    # Limit dashboard chart size
    chart_comparison = comparison[:50]

    # --------------------------------------------------------
    # Model information
    # --------------------------------------------------------

    model_type = type(model).__name__

    n_estimators = getattr(
        model,
        "n_estimators",
        None
    )

    n_features = getattr(
        model,
        "n_features_in_",
        len(FEATURES)
    )

    feature_names = getattr(
        model,
        "feature_names_in_",
        FEATURES
    )

    # --------------------------------------------------------
    # Feature importance
    # --------------------------------------------------------

    feature_importance = []

    if hasattr(model, "feature_importances_"):

        importances = model.feature_importances_

        for name, value in zip(
            feature_names,
            importances
        ):
            feature_importance.append({
                "feature": str(name),
                "importance": round(
                    float(value),
                    4
                )
            })

        feature_importance.sort(
            key=lambda item: item["importance"],
            reverse=True
        )

    # --------------------------------------------------------
    # Summary
    # --------------------------------------------------------

    return {
        "success": True,
        "available": True,

        "metrics": {
            "mae": round(float(mae), 3),
            "rmse": round(float(rmse), 3),
            "r2": round(float(r2), 3)
        },

        "samples": {
            "total": int(len(df))
        },

        "model": {
            "type": model_type,
            "estimators": n_estimators,
            "features": int(n_features),
            "feature_names": [
                str(x)
                for x in feature_names
            ]
        },

        "feature_importance": feature_importance,

        "comparison": chart_comparison
    }


# ============================================================
# COMMAND LINE EXECUTION
# ============================================================

if __name__ == "__main__":

    print("=" * 60)
    print("RailETA - Model Performance Evaluation")
    print("=" * 60)

    try:

        result = evaluate_model()

        if not result["available"]:

            print("\nEvaluation unavailable.")
            print(result["message"])

        else:

            print("\nModel:")
            print(
                result["model"]["type"]
            )

            print("\nMetrics:")
            print(
                f"MAE  : {result['metrics']['mae']} minutes"
            )

            print(
                f"RMSE : {result['metrics']['rmse']} minutes"
            )

            print(
                f"R²   : {result['metrics']['r2']}"
            )

            print(
                f"\nEvaluation samples: "
                f"{result['samples']['total']}"
            )

            print("\nFeature Importance:")

            for item in result[
                "feature_importance"
            ]:
                print(
                    f"  {item['feature']}: "
                    f"{item['importance']}"
                )

            print("\nEvaluation completed.")

    except Exception as e:

        print("\nEvaluation failed:")
        print(str(e))