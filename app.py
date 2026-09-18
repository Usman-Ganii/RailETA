from flask import Flask, jsonify, request, render_template
import joblib
import sqlite3
import pandas as pd
import requests
import os
import math  
from dotenv import load_dotenv
from datetime import datetime, timedelta
from evaluate_model import evaluate_model

load_dotenv()

RAILRADAR_API_KEY = os.getenv("RAILRADAR_API_KEY")

app = Flask(__name__)

model = joblib.load("model/eta_model.pkl")

FEATURE_NAMES = [
    "Current Delay",
    "Distance Remaining",
    "Stops Remaining",
    "Historical Avg. Delay"
]

FEATURE_IMPORTANCE = dict(
    zip(
        FEATURE_NAMES,
        model.feature_importances_
    )
)


def delay_to_minutes(value):
    if pd.isna(value):
        return 0

    try:
        return float(value)
    except:
        pass

    try:
        parts = str(value).split(":")

        if len(parts) == 3:
            hours = int(parts[0])
            minutes = int(parts[1])
            seconds = int(parts[2])

            return hours * 60 + minutes + seconds / 60

        if len(parts) == 2:
            hours = int(parts[0])
            minutes = int(parts[1])

            return hours * 60 + minutes

    except:
        return 0

    return 0


def haversine_distance(lat1, lon1, lat2, lon2):
    radius = 6371.0

    lat1 = math.radians(lat1)
    lon1 = math.radians(lon1)
    lat2 = math.radians(lat2)
    lon2 = math.radians(lon2)

    dlat = lat2 - lat1
    dlon = lon2 - lon1

    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1)
        * math.cos(lat2)
        * math.sin(dlon / 2) ** 2
    )

    c = 2 * math.atan2(
        math.sqrt(a),
        math.sqrt(1 - a)
    )

    return radius * c


def interpolate_point(lat1, lon1, lat2, lon2, fraction):
    fraction = max(0, min(fraction, 1))

    lat = lat1 + (lat2 - lat1) * fraction
    lon = lon1 + (lon2 - lon1) * fraction

    return lat, lon


def get_coordinates_from_geojson(geometry, target_distance_km):
    if not geometry:
        return None, None

    geometry_type = geometry.get("type")
    coordinates = geometry.get("coordinates")

    if geometry_type == "Feature":
        return get_coordinates_from_geojson(
            geometry.get("geometry"),
            target_distance_km
        )

    if geometry_type == "FeatureCollection":
        features = geometry.get("features", [])

        for feature in features:
            lat, lon = get_coordinates_from_geojson(
                feature,
                target_distance_km
            )

            if lat is not None:
                return lat, lon

        return None, None

    if not coordinates:
        return None, None

    if geometry_type == "MultiLineString":
        all_points = []

        for line in coordinates:
            for point in line:
                if isinstance(point, list) and len(point) >= 2:
                    all_points.append(point)

    elif geometry_type == "LineString":
        all_points = coordinates

    else:
        return None, None

    if len(all_points) < 2:
        return None, None

    cleaned_points = []

    for point in all_points:
        if isinstance(point, list) and len(point) >= 2:
            try:
                lon = float(point[0])
                lat = float(point[1])
                cleaned_points.append((lat, lon))
            except:
                pass

    if len(cleaned_points) < 2:
        return None, None

    remaining_distance = max(
        float(target_distance_km),
        0
    )

    for i in range(len(cleaned_points) - 1):
        lat1, lon1 = cleaned_points[i]
        lat2, lon2 = cleaned_points[i + 1]

        segment_distance = haversine_distance(
            lat1,
            lon1,
            lat2,
            lon2
        )

        if remaining_distance <= segment_distance:
            if segment_distance == 0:
                return lat1, lon1

            fraction = (
                remaining_distance / segment_distance
            )

            return interpolate_point(
                lat1,
                lon1,
                lat2,
                lon2,
                fraction
            )

        remaining_distance -= segment_distance

    return cleaned_points[-1]


def find_geojson_geometry(data):
    if isinstance(data, dict):
        if (
            "type" in data
            and "coordinates" in data
        ):
            geometry_type = data.get("type")

            if geometry_type in [
                "LineString",
                "MultiLineString",
                "Feature",
                "FeatureCollection"
            ]:
                return data

        for value in data.values():
            result = find_geojson_geometry(value)

            if result is not None:
                return result

    elif isinstance(data, list):
        for item in data:
            result = find_geojson_geometry(item)

            if result is not None:
                return result

    return None


def parse_datetime(value):
    if not value:
        return None

    value = str(value).strip()

    formats = [
        "%Y-%m-%d %H:%M",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%dT%H:%M:%S",
        "%d-%m-%Y %H:%M",
        "%d/%m/%Y %H:%M"
    ]

    try:
        parsed = datetime.fromisoformat(
            value.replace("Z", "+00:00")
        )

        if parsed.tzinfo is not None:
            parsed = parsed.replace(tzinfo=None)

        return parsed
    except:
        pass

    for date_format in formats:
        try:
            return datetime.strptime(
                value,
                date_format
            )
        except:
            pass

    return None

def save_prediction_history(
    train_name,
    scheduled_arrival,
    current_delay,
    predicted_additional_delay,
    total_delay,
    predicted_eta
):
    connection = None

    try:
        connection = sqlite3.connect(
            "database/train_eta.db"
        )

        cursor = connection.cursor()

        # ==========================================
        # CHECK THE MOST RECENT PREDICTION
        # FOR THIS TRAIN
        # ==========================================

        cursor.execute(
            """
            SELECT
                current_delay,
                predicted_additional_delay,
                total_delay,
                predicted_eta
            FROM predictions
            WHERE train_name = ?
            ORDER BY id DESC
            LIMIT 1
            """,
            (train_name,)
        )

        previous = cursor.fetchone()

        # ==========================================
        # AVOID SAVING DUPLICATE 30-SECOND UPDATES
        # ==========================================

        if previous:

            previous_current_delay = (
                float(previous[0] or 0)
            )

            previous_additional_delay = (
                float(previous[1] or 0)
            )

            previous_total_delay = (
                float(previous[2] or 0)
            )

            previous_eta = previous[3]

            current_delay_changed = (
                abs(
                    float(current_delay)
                    - previous_current_delay
                ) >= 1
            )

            additional_delay_changed = (
                abs(
                    float(predicted_additional_delay)
                    - previous_additional_delay
                ) >= 1
            )

            total_delay_changed = (
                abs(
                    float(total_delay)
                    - previous_total_delay
                ) >= 1
            )

            eta_changed = (
                str(predicted_eta or "")
                != str(previous_eta or "")
            )

            # If nothing meaningful changed,
            # do not create another history record.

            if not (
                current_delay_changed
                or additional_delay_changed
                or total_delay_changed
                or eta_changed
            ):
                return

        # ==========================================
        # SAVE NEW MEANINGFUL PREDICTION
        # ==========================================

        cursor.execute(
            """
            INSERT INTO predictions (
                train_name,
                scheduled_arrival,
                current_delay,
                predicted_additional_delay,
                total_delay,
                predicted_eta,
                prediction_time
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                train_name,
                scheduled_arrival,
                current_delay,
                predicted_additional_delay,
                total_delay,
                predicted_eta,
                datetime.now().strftime(
                    "%Y-%m-%d %H:%M:%S"
                )
            )
        )

        connection.commit()

    except Exception as error:

        print(
            "Prediction history save error:",
            error
        )

    finally:

        if connection:
            connection.close()


@app.route("/")
def home():
    return render_template("index.html")


def save_prediction(
    train_name,
    scheduled_arrival,
    current_delay,
    predicted_additional_delay,
    total_delay,
    predicted_eta
):
    connection = sqlite3.connect(
        "database/train_eta.db"
    )

    cursor = connection.cursor()

    cursor.execute(
        """
        INSERT INTO predictions (
            train_name,
            scheduled_arrival,
            current_delay,
            predicted_additional_delay,
            total_delay,
            predicted_eta,
            prediction_time
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            train_name,
            scheduled_arrival,
            current_delay,
            predicted_additional_delay,
            total_delay,
            predicted_eta,
            datetime.now().strftime(
                "%Y-%m-%d %H:%M:%S"
            )
        )
    )

    connection.commit()
    connection.close()


@app.route(
    "/predict",
    methods=["POST"]
)
@app.route("/predict", methods=["POST"])
def predict():
    try:
        data = request.get_json()

        if not data:
            return jsonify({
                "success": False,
                "error": "No prediction data received"
            }), 400

        train_name = str(data.get("train_name", "Unknown"))

        current_delay = float(data.get("current_delay", 0))
        distance_remaining = float(data.get("distance_remaining", 0))
        stops_remaining = float(data.get("stops_remaining", 0))
        historical_avg_delay = float(data.get("historical_avg_delay", 0))

        scheduled_arrival = str(
            data.get("scheduled_arrival", "")
        ).strip()

        if not scheduled_arrival:
            return jsonify({
                "success": False,
                "error": "Scheduled arrival time is required"
            }), 400

        scheduled_arrival_clean = scheduled_arrival.replace("T", " ")

        try:
            arrival_time = datetime.strptime(
                scheduled_arrival_clean,
                "%Y-%m-%d %H:%M"
            )
        except ValueError:
            try:
                arrival_time = datetime.fromisoformat(
                    scheduled_arrival
                )
            except ValueError:
                return jsonify({
                    "success": False,
                    "error": "Invalid scheduled arrival format"
                }), 400

        features = [[
            current_delay,
            distance_remaining,
            stops_remaining,
            historical_avg_delay
        ]]

        predicted_additional_delay = float(
            model.predict(features)[0]
        )

        predicted_additional_delay = max(
            predicted_additional_delay,
            0
        )

        total_delay = (
            current_delay
            + predicted_additional_delay
        )

        predicted_eta = (
            arrival_time
            + timedelta(minutes=total_delay)
        )

        predicted_eta_string = predicted_eta.strftime(
            "%Y-%m-%d %H:%M"
        )

        save_prediction(
            train_name,
            scheduled_arrival,
            current_delay,
            predicted_additional_delay,
            total_delay,
            predicted_eta_string
        )

        if total_delay <= 5:
            status = "On Time"
        elif total_delay <= 30:
            status = "Delayed"
        else:
            status = "Significantly Delayed"

        return jsonify({
            "success": True,
            "train_name": train_name,
            "current_delay": round(current_delay, 2),
            "predicted_additional_delay": round(
                predicted_additional_delay,
                2
            ),
            "total_delay": round(
                total_delay,
                2
            ),
            "predicted_eta": predicted_eta_string,
            "status": status
        })

    except Exception as error:
        print("Prediction Error:", error)

        return jsonify({
            "success": False,
            "error": str(error)
        }), 500



@app.route("/history")
def history():
    try:
        connection = sqlite3.connect(
            "database/train_eta.db"
        )

        connection.row_factory = sqlite3.Row

        cursor = connection.cursor()

        cursor.execute(
            """
            SELECT *
            FROM predictions
            ORDER BY id DESC
            LIMIT 10
            """
        )

        rows = cursor.fetchall()

        connection.close()

        predictions = [
            dict(row)
            for row in rows
        ]

        return jsonify(predictions)

    except Exception as error:
        return jsonify({
            "success": False,
            "error": str(error)
        }), 500


@app.route("/dashboard-stats")
def dashboard_stats():
    connection = None

    try:
        connection = sqlite3.connect(
            "database/train_eta.db"
        )

        connection.row_factory = sqlite3.Row

        cursor = connection.cursor()

        # Total predictions
        cursor.execute(
            """
            SELECT COUNT(*)
            FROM predictions
            """
        )

        total_predictions = cursor.fetchone()[0]

        # Average predicted delay
        cursor.execute(
            """
            SELECT AVG(total_delay)
            FROM predictions
            """
        )

        average_delay = cursor.fetchone()[0]

        if average_delay is None:
            average_delay = 0

        # Latest prediction
        cursor.execute(
            """
            SELECT
                train_name,
                predicted_eta,
                prediction_time
            FROM predictions
            ORDER BY id DESC
            LIMIT 1
            """
        )

        latest = cursor.fetchone()

        if latest:

            latest_train = (
                latest["train_name"]
            )

            latest_eta = (
                latest["predicted_eta"]
            )

            latest_prediction_time = (
                latest["prediction_time"]
            )

        else:

            latest_train = None
            latest_eta = None
            latest_prediction_time = None

        return jsonify({
            "success": True,

            "total_predictions":
                total_predictions,

            "average_predicted_delay":
                round(
                    float(average_delay),
                    2
                ),

            "latest_train":
                latest_train,

            "latest_eta":
                latest_eta,

            "latest_prediction_time":
                latest_prediction_time
        })

    except Exception as error:

        print(
            "Dashboard Stats Error:",
            error
        )

        return jsonify({
            "success": False,
            "error": str(error)
        }), 500

    finally:

        if connection:
            connection.close()


@app.route("/trains")
def trains():
    try:
        df = pd.read_csv(
            "data/indian_railway_delay_data.csv"
        )

        df["delay_numeric"] = (
            df["Dealy_min"].apply(
                delay_to_minutes
            )
        )

        historical_avg = (
            df.groupby("Train_no")[
                "delay_numeric"
            ]
            .mean()
            .to_dict()
        )

        trains = []

        for _, row in df.iterrows():
            train_no = row["Train_no"]

            distance = pd.to_numeric(
                row["Distance(Km)"],
                errors="coerce"
            )

            if pd.isna(distance):
                distance = 0

            current_delay = (
                delay_to_minutes(
                    row["Dealy_min"]
                )
            )

            avg_delay = historical_avg.get(
                train_no,
                current_delay
            )

            if pd.isna(avg_delay):
                avg_delay = current_delay

            trains.append({
                "train_no": str(train_no),
                "train_name": str(
                    row["Train_name"]
                ),
                "source": str(
                    row["Source"]
                ),
                "destination": str(
                    row["Destitnation"]
                ),
                "distance_km": float(
                    distance
                ),
                "current_delay": float(
                    current_delay
                ),
                "historical_avg_delay": round(
                    float(avg_delay),
                    2
                )
            })

        return jsonify(trains)

    except Exception as error:
        return jsonify({
            "success": False,
            "error": str(error)
        }), 500


@app.route("/feature-importance")
def feature_importance():
    importance = {
        key: round(
            float(value) * 100,
            2
        )
        for key, value
        in FEATURE_IMPORTANCE.items()
    }

    return jsonify(importance)

@app.route("/model-performance")
def model_performance():
    try:
        from evaluate_model import evaluate_model

        result = evaluate_model()

        return jsonify(result)

    except Exception as error:
        print("Model Performance Error:", error)

        return jsonify({
            "success": False,
            "available": False,
            "error": str(error)
        }), 500


@app.route(
    "/live-train/<train_number>"
)
def live_train(train_number):
    if not RAILRADAR_API_KEY:
        return jsonify({
            "success": False,
            "error": "RailRadar API key not configured"
        }), 500

    url = (
        f"https://api.railradar.in/v1/"
        f"trains/{train_number}/live"
    )

    headers = {
        "Authorization":
            f"Bearer {RAILRADAR_API_KEY}"
    }

    try:
        response = requests.get(
            url,
            headers=headers,
            timeout=10
        )

        if response.status_code != 200:
            return jsonify({
                "success": False,
                "error":
                    "RailRadar API request failed",
                "status_code":
                    response.status_code
            }), response.status_code

        data = response.json()

        train = data.get(
            "data",
            {}
        )

        train_info = train.get(
            "train",
            {}
        )

        current_location = train.get(
            "currentLocation",
            {}
        )

        next_halt = train.get(
            "nextHalt",
            {}
        )

        clean_data = {
            "train_number":
                train.get(
                    "trainNumber",
                    train_number
                ),

            "train_name":
                train.get(
                    "trainName",
                    train_info.get(
                        "name",
                        "Unknown"
                    )
                ),

            "status":
                train.get(
                    "status",
                    "unknown"
                ),

            "delay_minutes":
                train.get(
                    "delayMinutes",
                    0
                ),

            "current_station":
                current_location.get(
                    "stationCode",
                    "Unknown"
                ),

            "next_station":
                next_halt.get(
                    "stationName",
                    next_halt.get(
                        "stationCode",
                        "Unknown"
                    )
                ),

            "is_live":
                train.get(
                    "isLive",
                    False
                )
        }

        return jsonify({
            "success": True,
            "data": clean_data
        })

    except requests.exceptions.RequestException as error:
        return jsonify({
            "success": False,
            "error":
                "Unable to connect to RailRadar",
            "details":
                str(error)
        }), 503

    except Exception as error:
        return jsonify({
            "success": False,
            "error": str(error)
        }), 500


@app.route("/live-predict/<train_number>")
def live_predict(train_number):
    if not RAILRADAR_API_KEY:
        return jsonify({
            "success": False,
            "error": "RailRadar API key not configured"
        }), 500

    url = (
        f"https://api.railradar.in/v1/"
        f"trains/{train_number}/live"
    )

    headers = {
        "Authorization":
            f"Bearer {RAILRADAR_API_KEY}"
    }

    params = {
        "geometry": "true",
        "format": "geojson",
        "includeCoordinates": "true"
    }

    try:
        response = requests.get(
            url,
            headers=headers,
            params=params,
            timeout=15
        )

        if response.status_code != 200:

            print("\n========== RAILRADAR API ERROR ==========")
            print("Status Code:", response.status_code)
            print("Response:", response.text)
            print("=========================================\n")

            if response.status_code == 429:
                retry_after = response.headers.get(
                    "Retry-After",
                    "120"
                )

                return jsonify({
                    "success": False,
                    "error": (
                        "RailRadar API rate limit reached. "
                        "Please wait before requesting live data again."
                    ),
                    "status_code": 429,
                    "retry_after": retry_after,
                    "details": response.text
                }), 429

            if response.status_code == 401:
                return jsonify({
                    "success": False,
                    "error": (
                        "RailRadar API key is invalid, expired, "
                        "or not authorized."
                    ),
                    "status_code": 401,
                    "details": response.text
                }), 401

            if response.status_code == 404:
                return jsonify({
                    "success": False,
                    "error": (
                        "Train was not found in RailRadar "
                        "for the current journey."
                    ),
                    "status_code": 404,
                    "details": response.text
                }), 404

            return jsonify({
                "success": False,
                "error": "RailRadar API request failed",
                "status_code": response.status_code,
                "details": response.text
            }), response.status_code

        live_data = response.json()

    except requests.exceptions.RequestException as error:
        return jsonify({
            "success": False,
            "error": "Unable to connect to RailRadar",
            "details": str(error)
        }), 503

    except ValueError as error:
        return jsonify({
            "success": False,
            "error": "RailRadar returned invalid JSON",
            "details": str(error)
        }), 502

    try:
        data = live_data.get("data", {})
        train_info = data.get("train", {})
        current_location = data.get("currentLocation", {})

        train_name = data.get(
            "trainName",
            train_info.get(
                "name",
                "Unknown"
            )
        )

        current_delay = float(
            data.get(
                "delayMinutes",
                0
            ) or 0
        )

        df = pd.read_csv(
            "data/indian_railway_delay_data.csv"
        )

        df["delay_numeric"] = (
            df["Dealy_min"].apply(
                delay_to_minutes
            )
        )

        train_rows = df[
            df["Train_no"].astype(str)
            == str(train_number)
        ]

        if len(train_rows) > 0:
            historical_avg_delay = float(
                train_rows["delay_numeric"].mean()
            )
        else:
            historical_avg_delay = current_delay

        route = data.get(
                    "route",
                    []
                )
        print("\n========== RAILRADAR DEBUG ==========")
        print("TRAIN INFO:", train_info)
        print("CURRENT LOCATION:", current_location)
        print("ROUTE COUNT:", len(route))
        print("FIRST ROUTE STATION:", route[0] if route else "NO ROUTE")
        print("LAST ROUTE STATION:", route[-1] if route else "NO ROUTE")
        print("=====================================\n")

        total_distance = float(
            train_info.get(
                "distance",
                0
            ) or 0
        )

# Fallback: use the final station's distance
# if the train information does not contain total distance.
        if total_distance <= 0 and route:
            route_distances = []

            for station in route:
                station_distance = station.get("distance")

                if station_distance is not None:
                    try:
                        station_distance = float(station_distance)

                        if station_distance > 0:
                            route_distances.append(
                                station_distance
                            )
                    except (TypeError, ValueError):
                        pass

            if route_distances:
                total_distance = max(route_distances)

        current_sequence = int(
            current_location.get(
                "sequence",
                1
            ) or 1
        )

        

        distance_from_origin = float(
            current_location.get(
                "distanceFromOriginKm",
                0
            ) or 0
        )

        current_lat = None
        current_lng = None

        geometry = find_geojson_geometry(data)

        if geometry:
            current_lat, current_lng = (
                get_coordinates_from_geojson(
                    geometry,
                    distance_from_origin
                )
            )

        distance_completed = distance_from_origin
        distance_remaining = max(
            total_distance - distance_completed,
            0
        )

        future_stops = 0

        for station in route:
            sequence = station.get(
                "sequence",
                0
            )

            if (
                sequence > current_sequence
                and station.get(
                    "isHalt",
                    False
                )
            ):
                future_stops += 1

        stops_remaining = future_stops

        next_station = None

        for station in route:
            if station.get("status") == "upcoming":
                next_station = station
                break

        if next_station is None:
            for station in route:
                sequence = station.get(
                    "sequence",
                    0
                )

                if sequence > current_sequence:
                    next_station = station
                    break

        features = [[
            current_delay,
            distance_remaining,
            stops_remaining,
            historical_avg_delay
        ]]

        predicted_additional_delay = float(
            model.predict(features)[0]
        )

        predicted_additional_delay = max(
            predicted_additional_delay,
            0
        )

        total_delay = (
            current_delay
            + predicted_additional_delay
        )

        # ==========================================
        # AI PREDICTION EXPLANATION
        # ==========================================

        feature_names = [
            "current_delay",
            "historical_avg_delay",
            "distance_remaining",
            "stops_remaining"
        ]

        feature_labels = {
            "current_delay":
            "Current train delay",

            "historical_avg_delay":
            "Historical average delay",

            "distance_remaining":
            "Distance remaining",

            "stops_remaining":
            "Stops remaining"
        }

        feature_importances = (
            model.feature_importances_
        )

        explanation_factors = []

        for name, importance, value in zip(
            feature_names,
            feature_importances,
            features[0]
        ):

            explanation_factors.append({
                "feature": name,
                "label": feature_labels[name],
                "importance": round(
                    float(importance) * 100,
                    2
                ),
                "value": round(
                    float(value),
                    2
                )
            })


        explanation_factors.sort(
            key=lambda item: item["importance"],
            reverse=True
        )

        primary_factor = (
            explanation_factors[0]
            if explanation_factors
            else None
        )

        if primary_factor:

            primary_factor_text = (
                f"{primary_factor['label']} "
                f"is the strongest factor influencing "
                f"the AI prediction "
                f"({primary_factor['importance']}% "
                f"global model importance)."
            )

        else:
            primary_factor_text = (
                "The AI prediction was generated "
                "from the available live train features."
            )


        

        predicted_eta = None

        if next_station:
            scheduled_arrival = (
                next_station.get("scheduledArrival")
                or next_station.get("arrivalTime")
                or next_station.get("scheduledArrivalTime")
            )

            if scheduled_arrival:
                try:
                    scheduled_time = datetime.fromisoformat(
                        str(scheduled_arrival).replace(
                            "Z",
                            "+00:00"
                        )
                    )

                    if scheduled_time.tzinfo:
                        scheduled_time = (
                            scheduled_time.replace(
                                tzinfo=None
                            )
                        )

                    predicted_eta_time = (
                        scheduled_time
                        + timedelta(
                            minutes=total_delay
                        )
                    )

                    predicted_eta = (
                        predicted_eta_time.strftime(
                            "%Y-%m-%d %H:%M"
                        )
                    )

                except (ValueError, TypeError):
                    predicted_eta = None

        if predicted_eta is None:
            estimated_speed = 50

            if next_station:
                next_distance = float(
                    next_station.get(
                        "distance",
                        distance_completed
                    ) or distance_completed
                )

                distance_to_next = max(
                    next_distance - distance_from_origin,
                    0
                )
            else:
                distance_to_next = distance_remaining

            travel_minutes = (
                distance_to_next
                / estimated_speed
                * 60
            )

            predicted_eta_time = (
                datetime.now()
                + timedelta(
                    minutes=travel_minutes
                    + predicted_additional_delay
                )
            )

            predicted_eta = (
                predicted_eta_time.strftime(
                    "%Y-%m-%d %H:%M"
                )
            )

        if next_station:
            next_station_name = (
                next_station.get("stationName")
                or next_station.get("station")
                or next_station.get(
                    "stationCode",
                    "Unknown"
                )
            )
        else:
            next_station_name = "Unknown"

        route_coordinates = []

        for station in route:
            lat = station.get("lat")
            lng = station.get("lng")

            if lat is not None and lng is not None:
                try:
                    route_coordinates.append({
                        "latitude": float(lat),
                        "longitude": float(lng),
                        "station": station.get(
                            "stationName"
                        ) or station.get(
                            "stationCode",
                            "Unknown"
                        ),
                        "sequence": station.get(
                            "sequence",
                            0
                        ),
                        "status": station.get(
                            "status",
                            ""
                        )
                    })
                except (ValueError, TypeError):
                    pass

        if total_delay <= 5:
            status = "On Time"
        elif total_delay <= 30:
            status = "Delayed"
        else:
            status = "Significantly Delayed"

        # Save this live prediction to history
        scheduled_arrival = None

        if next_station:
            scheduled_arrival = (
                next_station.get("scheduledArrival")
                or next_station.get("arrivalTime")
                or next_station.get("scheduledArrivalTime")
            )

        save_prediction_history(
            train_name=train_name,
            scheduled_arrival=scheduled_arrival,
            current_delay=current_delay,
            predicted_additional_delay=predicted_additional_delay,
            total_delay=total_delay,
            predicted_eta=predicted_eta
        )

        return jsonify({
            "success": True,
            "train": {
                "number": str(train_number),
                "name": train_name,
                "status": data.get(
                    "status",
                    status
                )
            },
            "live": {
                "current_delay": round(
                    current_delay,
                    2
                ),
                "current_station": current_location.get(
                    "stationCode",
                    current_location.get(
                        "stationName",
                        "Unknown"
                    )
                ),
                "next_station": next_station_name,
                "latitude": current_lat,
                "longitude": current_lng,
                "route": route_coordinates
            },
            "model_input": {
                "distance_remaining": round(
                    distance_remaining,
                    2
                ),
                "stops_remaining": stops_remaining,
                "historical_avg_delay": round(
                    historical_avg_delay,
                    2
                )
            },
            "prediction": {
    "additional_delay": round(
        predicted_additional_delay,
        2
    ),

    "total_delay": round(
        total_delay,
        2
    ),

    "predicted_eta": predicted_eta,

    "status": status,

    "explanation": {
        "summary": primary_factor_text,
        "factors": explanation_factors
    }
}
        })

    except Exception as error:
        print("Live Prediction Error:", error)

        return jsonify({
            "success": False,
            "error": str(error)
        }), 500

if __name__ == "__main__":
    app.run(debug=True)