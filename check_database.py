import sqlite3

connection = sqlite3.connect("database/train_eta.db")

cursor = connection.cursor()

cursor.execute("SELECT * FROM predictions")

rows = cursor.fetchall()

print("----- SAVED PREDICTIONS -----")

for row in rows:
    print(row)

connection.close()