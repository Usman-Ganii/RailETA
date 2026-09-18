import os
from dotenv import load_dotenv

load_dotenv()

api_key = os.getenv("RAILRADAR_API_KEY")

if api_key:
    print("RailRadar API key loaded successfully!")
    print("Key detected:", api_key[:8] + "********")
else:
    print("API key NOT found!")