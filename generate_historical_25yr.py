import pandas as pd
import numpy as np
from datetime import datetime, timedelta

MANDIS = [
    ("Lasalgaon", "Nashik"), ("Pimpalgaon", "Nashik"), ("Nashik APMC", "Nashik"),
    ("Pune (Gultekdi)", "Pune"), ("Pimpri", "Pune"), ("Mumbai APMC", "Mumbai"),
    ("Panvel", "Raigad"), ("Kalyan", "Thane"), ("Ahmednagar", "Ahmednagar"),
    ("Sangamner", "Ahmednagar"), ("Solapur", "Solapur"), ("Kolhapur", "Kolhapur")
]

CROPS = {
    "Onion": (350, 2200, 0.045),
    "Tomato": (400, 2600, 0.065),
    "Potato": (300, 1400, 0.030),
    "Chilli": (1200, 5200, 0.055),
    "Soyabean": (1100, 4400, 0.020),
    "Wheat": (600, 2400, 0.012)
}

def generate_25yr_dataset(output_file="agmarknet_1999_2024.csv"):
    print("🌾 Generating 25-year historical market sequence (1999–2024)...")
    start_date = datetime(1999, 1, 1)
    end_date = datetime(2024, 12, 31)
    days = (end_date - start_date).days

    records = []
    
    for crop, (p_1999, p_2024, vol) in CROPS.items():
        for mandi, dist in MANDIS:
            cagr = (p_2024 / p_1999) ** (1 / 25) - 1
            
            for d in range(0, days, 2):  # Every 2 days
                dt = start_date + timedelta(days=d)
                day_of_year = dt.timetuple().tm_yday
                
                # Annual harvest cycle wave
                seasonal_multiplier = 1.0 + 0.20 * np.sin(2 * np.pi * day_of_year / 365.25)
                
                # 25-year macro inflation curve
                year_fraction = d / 365.25
                trend_price = p_1999 * ((1 + cagr) ** year_fraction)
                
                # Daily volatility
                noise = np.random.normal(0, vol * 0.5)
                modal_price = round(trend_price * seasonal_multiplier * (1 + noise), 2)
                arrivals = round(max(5.0, np.random.normal(45, 15)), 1)
                
                records.append({
                    "State": "Maharashtra",
                    "District": dist,
                    "Market": mandi,
                    "Commodity": crop,
                    "Arrival_Date": dt.strftime("%d/%m/%Y"),
                    "Modal_Price": max(100.0, modal_price),
                    "Arrivals": arrivals
                })

    df = pd.DataFrame(records)
    df.to_csv(output_file, index=False)
    print(f"✅ Generated {len(df):,} historical records in '{output_file}'!")

if __name__ == "__main__":
    generate_25yr_dataset()