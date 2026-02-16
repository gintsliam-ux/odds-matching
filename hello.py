import random
import time

greetings = [
    "Hello, World!",
    "Hola, Mundo!",
    "Bonjour, le Monde!",
    "Hallo, Welt!",
    "Ciao, Mondo!",
    "Olá, Mundo!",
    "Привет, мир!",
    "こんにちは、世界！",
    "你好，世界！",
    "Hej, Världen!",
]

name = input("What's your name? ")
greeting = random.choice(greetings)
print(f"\n{greeting}")
print(f"Welcome, {name}! 🌍")
print(f"Fun fact: This greeting was picked from {len(greetings)} languages.")
print(f"Current time: {time.strftime('%I:%M %p')}")
