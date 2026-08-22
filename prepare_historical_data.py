import pandas as pd
import numpy as np

def preprocess_25yr_mandi_data(raw_csv_path: str = "agmarknet_1999_2024.csv", output_parquet_path: str = "bhavnetra_clean_25yr.parquet"):
    print("🌾 Loading raw historical Agmarknet records...")
    df = pd.read_csv(raw_csv_path)
    
    # 1. Standardize column names
    df = df.rename(columns={
        'Arrival_Date': 'date',
        'State': 'state',
        'District': 'district',
        'Market': 'market',
        'Commodity': 'commodity',
        'Modal_Price': 'modal_price',
        'Arrivals': 'arrivals_tonnes'
    })

    # 2. Convert date strings explicitly to Datetime objects
    df['date'] = pd.to_datetime(df['date'], format='mixed', dayfirst=True)

    # 3. Clean numeric columns and remove corrupt entries
    df['modal_price'] = pd.to_numeric(df['modal_price'], errors='coerce')
    df['arrivals_tonnes'] = pd.to_numeric(df['arrivals_tonnes'], errors='coerce').fillna(10.0)
    df = df.dropna(subset=['date', 'modal_price', 'commodity', 'market'])
    df = df[df['modal_price'] > 50]

    processed_series = []
    
    print("⚙️ Engineering multi-scale market features, supply elasticity, and lag windows...")
    for (mandi, crop), group in df.groupby(['market', 'commodity']):
        group = group.sort_values('date').drop_duplicates('date')
        
        # Set DatetimeIndex for chronological daily resampling
        group = group.set_index(pd.DatetimeIndex(group['date']))
        
        # Resample daily and forward-fill market closures / holidays
        daily = group.resample('D').agg({
            'modal_price': 'ffill',
            'arrivals_tonnes': 'mean',
            'district': 'first',
            'state': 'first'
        })
        daily['arrivals_tonnes'] = daily['arrivals_tonnes'].fillna(0.0)
        daily['market'] = mandi
        daily['commodity'] = crop
        
        # ==========================================
        # 1. TEMPORAL & CYCLICAL SIGNALS
        # ==========================================
        daily['time_idx'] = (daily.index - daily.index.min()).days
        daily['day_of_week'] = daily.index.dayofweek
        daily['day_of_year'] = daily.index.dayofyear
        daily['month'] = daily.index.month
        daily['quarter'] = daily.index.quarter
        daily['year'] = daily.index.year
        
        # Cyclical Seasonality Encoding (Yearly & Weekly)
        daily['sin_day'] = np.sin(2 * np.pi * daily['day_of_year'] / 365.25)
        daily['cos_day'] = np.cos(2 * np.pi * daily['day_of_year'] / 365.25)
        daily['sin_dow'] = np.sin(2 * np.pi * daily['day_of_week'] / 7.0)
        daily['cos_dow'] = np.cos(2 * np.pi * daily['day_of_week'] / 7.0)
        
        # ==========================================
        # 2. MULTI-SCALE PRICE LAGS & MOVING AVERAGES
        # ==========================================
        daily['price_lag_1'] = daily['modal_price'].shift(1)
        daily['price_lag_3'] = daily['modal_price'].shift(3)
        daily['price_lag_7'] = daily['modal_price'].shift(7)
        daily['price_lag_14'] = daily['modal_price'].shift(14)
        daily['price_lag_30'] = daily['modal_price'].shift(30)
        
        # Exponential Moving Averages & Rolling Means
        daily['ema_7d'] = daily['modal_price'].ewm(span=7, adjust=False).mean()
        daily['ema_21d'] = daily['modal_price'].ewm(span=21, adjust=False).mean()
        daily['rolling_mean_7d'] = daily['modal_price'].rolling(7).mean()
        daily['rolling_mean_30d'] = daily['modal_price'].rolling(30).mean()
        
        # Volatility & Momentum
        daily['rolling_std_7d'] = daily['modal_price'].rolling(7).std().fillna(0)
        daily['rolling_std_30d'] = daily['modal_price'].rolling(30).std().fillna(0)
        daily['price_change_7d'] = (daily['modal_price'] - daily['price_lag_7']) / (daily['price_lag_7'] + 1e-5)
        
        # ==========================================
        # 3. SUPPLY & ARRIVALS ELASTICITY
        # ==========================================
        daily['arrivals_lag_1'] = daily['arrivals_tonnes'].shift(1)
        daily['arrivals_lag_7'] = daily['arrivals_tonnes'].shift(7)
        daily['arrivals_rolling_7d'] = daily['arrivals_tonnes'].rolling(7).mean()
        daily['arrivals_rolling_30d'] = daily['arrivals_tonnes'].rolling(30).mean()
        
        # Arrival Inflow Shock Ratio (Current arrivals vs 30-day median)
        median_30d = daily['arrivals_tonnes'].rolling(30).median().replace(0, 1.0)
        daily['arrival_shock_ratio'] = daily['arrivals_tonnes'] / median_30d
        
        # ==========================================
        # 4. MULTI-HORIZON TARGETS
        # ==========================================
        # 2-Day Forward Target (Immediate spot trading / arbitration)
        daily['target_price_2d'] = daily['modal_price'].shift(-2)
        daily['target_pct_2d'] = (daily['target_price_2d'] - daily['modal_price']) / daily['modal_price']
        
        # 7-Day Forward Target (Weekly harvest cycle planning)
        daily['target_price_7d'] = daily['modal_price'].shift(-7)
        daily['target_pct_7d'] = (daily['target_price_7d'] - daily['modal_price']) / daily['modal_price']
        
        processed_series.append(daily.dropna())

    if not processed_series:
        print("❌ No series could be processed. Check raw CSV contents.")
        return

    final_df = pd.concat(processed_series).reset_index(names='date')
    
    # Export to high-performance Parquet format
    final_df.to_parquet(output_parquet_path, index=False)
    print(f"✅ Successfully compiled {len(final_df):,} enriched feature rows into '{output_parquet_path}'!")

if __name__ == "__main__":
    preprocess_25yr_mandi_data("agmarknet_1999_2024.csv", "bhavnetra_clean_25yr.parquet")