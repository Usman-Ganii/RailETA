import pandas as pd
import numpy as np

# ==========================================
# FILES
# ==========================================

INPUT_FILE = "data/indian_railway_delay_data.csv"
OUTPUT_FILE = "data/processed_train_data.csv"
EVALUATION_FILE = "data/model_evaluation.csv"


# ==========================================
# READ DATA
# ==========================================

df = pd.read_csv(INPUT_FILE)

print("Rows:", len(df))

print("\nOriginal columns:")
print(df.columns.tolist())


# ==========================================
# CONVERT DELAY TO MINUTES
# ==========================================

def delay_to_minutes(value):

    if pd.isna(value):
        return np.nan

    # If already a number
    try:
        return float(value)
    except:
        pass

    # If format is HH:MM:SS or HH:MM
    try:

        parts = str(value).split(":")

        if len(parts) == 3:

            hours = int(parts[0])
            minutes = int(parts[1])
            seconds = int(parts[2])

            return (
                hours * 60
                + minutes
                + seconds / 60
            )

        if len(parts) == 2:

            hours = int(parts[0])
            minutes = int(parts[1])

            return (
                hours * 60
                + minutes
            )

    except:
        return np.nan

    return np.nan


df["delay_minutes"] = (
    df["Dealy_min"].apply(
        delay_to_minutes
    )
)


# ==========================================
# CONVERT DISTANCE
# ==========================================

df["distance_km"] = pd.to_numeric(
    df["Distance(Km)"],
    errors="coerce"
)


# ==========================================
# SORT DATA
# ==========================================
#
# Sort by train number and date so that
# historical information only comes from
# earlier observations.
#

if "Date" in df.columns:

    df["parsed_date"] = pd.to_datetime(
        df["Date"],
        errors="coerce"
    )

    df = df.sort_values(
        [
            "Train_no",
            "parsed_date"
        ]
    ).reset_index(drop=True)

else:

    df = df.sort_values(
        "Train_no"
    ).reset_index(drop=True)


# ==========================================
# HISTORICAL AVERAGE DELAY
# ==========================================
#
# IMPORTANT:
#
# Do NOT include the current row's delay
# when calculating its historical average.
#
# This prevents data leakage.
#

df["historical_avg_delay"] = (
    df.groupby("Train_no")["delay_minutes"]
      .transform(
          lambda series:
          series.shift(1).expanding().mean()
      )
)


# ==========================================
# FALLBACK HISTORICAL DELAY
# ==========================================
#
# For the first observation of a train there
# is no previous historical observation.
#
# Use the overall historical average instead.
#

overall_historical_average = (
    df["delay_minutes"].mean()
)

df["historical_avg_delay"] = (
    df["historical_avg_delay"]
    .fillna(
        overall_historical_average
    )
)


# ==========================================
# STOPS REMAINING
# ==========================================
#
# The source dataset does not contain actual
# remaining-stop information.
#
# For this prototype, estimate stops from
# distance.
#

df["stops_remaining"] = np.ceil(
    df["distance_km"] / 50
)


# ==========================================
# CURRENT DELAY
# ==========================================

df["current_delay"] = (
    df["delay_minutes"]
)


# ==========================================
# ADDITIONAL DELAY TARGET
# ==========================================
#
# Additional delay represents the amount by
# which the current delay exceeds the
# historical baseline.
#

df["additional_delay"] = (
    df["current_delay"]
    - df["historical_avg_delay"]
)


df["additional_delay"] = (
    df["additional_delay"]
    .clip(lower=0)
)


# ==========================================
# SELECT ML COLUMNS
# ==========================================

processed = df[
    [
        "current_delay",
        "distance_km",
        "stops_remaining",
        "historical_avg_delay",
        "additional_delay"
    ]
].copy()


# ==========================================
# CLEAN DATA
# ==========================================

processed = processed.replace(
    [np.inf, -np.inf],
    np.nan
)

processed = processed.dropna()


# ==========================================
# RENAME DISTANCE COLUMN
# ==========================================

processed = processed.rename(
    columns={
        "distance_km":
            "distance_remaining"
    }
)


# ==========================================
# SAVE PROCESSED DATA
# ==========================================

processed.to_csv(
    OUTPUT_FILE,
    index=False
)


# ==========================================
# SAVE MODEL EVALUATION DATA
# ==========================================

processed.to_csv(
    EVALUATION_FILE,
    index=False
)


# ==========================================
# OUTPUT
# ==========================================

print("\n================================")
print("PROCESSING COMPLETED")
print("================================")

print(
    "Rows processed:",
    len(processed)
)

print("\nProcessed columns:")

print(
    processed.columns.tolist()
)

print("\nFirst 5 rows:")

print(
    processed.head()
)

print("\nSaved processed dataset to:")

print(
    OUTPUT_FILE
)

print("\nSaved evaluation dataset to:")

print(
    EVALUATION_FILE
)

print("\nHistorical delay calculation:")

print(
    "Previous observations only — "
    "current row excluded."
)