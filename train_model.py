import pandas as pd
import numpy as np
import xgboost as xgb
from sklearn.model_selection import TimeSeriesSplit
from sklearn.metrics import mean_absolute_error, mean_squared_error
import os

def train_25yr_mandi_model(parquet_path="bhavnetra_clean_25yr.parquet", output_model="bhavnetra_xgb_model.json"):
    print("🌾 Loading engineered 25-year dataset...")
    df = pd.read_parquet(parquet_path)
    
    # Feature columns engineered from the 25-year sequence
    features = [
        'modal_price',
        'arrivals_tonnes',
        'day_of_week',
        'day_of_year',
        'month',
        'year',
        'sin_day',
        'cos_day',
        'price_lag_1',
        'price_lag_7',
        'rolling_mean_7d',
        'rolling_std_7d'
    ]
    
    X = df[features]
    y = df['target_pct_2d']  # Predict 2-day percentage swing

    print(f"📊 Training on {len(df):,} historical market records across Maharashtra APMCs...")

    # TimeSeriesSplit ensures no future data leaks into the past
    tscv = TimeSeriesSplit(n_splits=5)

    model = xgb.XGBRegressor(
        n_estimators=600,
        learning_rate=0.03,
        max_depth=6,
        subsample=0.85,
        colsample_bytree=0.85,
        objective="reg:squarederror",
        random_state=42
    )

    # Walk-forward validation across the 25-year timeline
    for fold, (train_idx, val_idx) in enumerate(tscv.split(X)):
        X_train, X_val = X.iloc[train_idx], X.iloc[val_idx]
        y_train, y_val = y.iloc[train_idx], y.iloc[val_idx]
        
        model.fit(
            X_train, y_train,
            eval_set=[(X_val, y_val)],
            verbose=False
        )

    # Evaluate final split
    preds = model.predict(X_val)
    mae = mean_absolute_error(y_val, preds)
    rmse = np.sqrt(mean_squared_error(y_val, preds))
    
    print(f"✅ Training Complete!")
    print(f"🎯 Validation MAE (Mean Absolute Error on 2-day change): {mae * 100:.2f}%")
    print(f"🎯 Validation RMSE: {rmse * 100:.2f}%")

    # Save lightweight JSON model for sub-millisecond inference in production
    model.save_model(output_model)
    print(f"💾 Trained model saved to: {output_model}")

if __name__ == "__main__":
    train_25yr_mandi_model()