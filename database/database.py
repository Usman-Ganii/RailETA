import sqlite3

DATABASE = "database/train_eta.db"


def create_database():
    connection = sqlite3.connect(DATABASE)

    cursor = connection.cursor()

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS predictions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            train_name TEXT,
            scheduled_arrival TEXT,
            current_delay REAL,
            predicted_additional_delay REAL,
            total_delay REAL,
            predicted_eta TEXT,
            prediction_time TEXT
        )
    """)

    connection.commit()
    connection.close()

    print("Database created successfully!")


if __name__ == "__main__":
    create_database()