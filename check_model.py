import joblib

model = joblib.load("model/eta_model.pkl")

print("Model loaded successfully!")
print("Model type:", type(model).__name__)
print("Number of trees:", model.n_estimators)
print("Number of features:", model.n_features_in_)