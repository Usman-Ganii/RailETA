import pandas as pd


INPUT_FILE = "data/real_train_data.csv"
OUTPUT_FILE = "data/processed_train_data.csv"


# Load the dataset
df = pd.read_csv(INPUT_FILE)

print("Original columns:")
print(df.columns.tolist())


# Required columns for our ML model
required_columns = [
    "current_delay",
    "distance_remaining",
    "stops_remaining",
    "historical_avg_delay",
    "additional_delay"
]


# Check whether required columns exist
missing_columns = [
    column for column in required_columns
    if column not in df.columns
]

if missing_columns:

    print("\nMissing columns:")
    print(missing_columns)

    print("\nPlease map the source dataset columns to our required features.")

else:

    # Keep only required columns
    df = df[required_columns]

    # Remove missing values
    df = df.dropna()

    # Save processed dataset
    df.to_csv(OUTPUT_FILE, index=False)

    print("\nData preprocessing completed!")
    print("Rows:", len(df))
    print("Saved to:", OUTPUT_FILE)