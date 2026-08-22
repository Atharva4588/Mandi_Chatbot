import os
import joblib
import numpy as np
import pandas as pd
from sklearn.model_selection import TimeSeriesSplit
from sklearn.metrics import mean_absolute_error, mean_squared_error
from sklearn.linear_model import Ridge

import xgboost as xgb
import lightgbm as lgb
from catboost import CatBoostRegressor

# ==========================================
# 1. CONFIGURATION & FEATURE SPECIFICATION
# ==========================================
PARQUET_PATH = "bhavnetra_clean_25yr.parquet"
MODEL_DIR = "ensemble_models"
os.makedirs(MODEL_DIR, exist_ok=True)

FEATURES = [
    # Base Market Indicators
    'modal_price',
    'arrivals_tonnes',
    
    # Temporal & Cyclical Signals
    'day_of_week',
    'day_of_year',
    'month',
    'quarter',
    'year',
    'sin_day',
    'cos_day',
    'sin_dow',
    'cos_dow',
    
    # Multi-Scale Price Lags & Moving Averages
    'price_lag_1',
    'price_lag_3',
    'price_lag_7',
    'price_lag_14',
    'price_lag_30',
    'ema_7d',
    'ema_21d',
    'rolling_mean_7d',
    'rolling_mean_30d',
    'rolling_std_7d',
    'rolling_std_30d',
    'price_change_7d',
    
    # Supply & Arrivals Elasticity
    'arrivals_lag_1',
    'arrivals_lag_7',
    'arrivals_rolling_7d',
    'arrivals_rolling_30d',
    'arrival_shock_ratio'
]

TARGET = 'target_pct_2d'


# ==========================================
# 2. MODEL INITIALIZERS
# ==========================================
def get_xgb_model():
    return xgb.XGBRegressor(
        n_estimators=1000,
        learning_rate=0.02,
        max_depth=6,
        min_child_weight=3,
        subsample=0.85,
        colsample_bytree=0.85,
        objective="reg:squarederror",
        random_state=42,
        tree_method="hist",
        early_stopping_rounds=40
    )

def get_lgb_model():
    return lgb.LGBMRegressor(
        n_estimators=1000,
        learning_rate=0.02,
        num_leaves=63,
        max_depth=-1,
        subsample=0.85,
        colsample_bytree=0.85,
        objective="regression",
        random_state=42,
        verbosity=-1
    )

def get_cat_model():
    return CatBoostRegressor(
        iterations=1000,
        learning_rate=0.03,
        depth=6,
        loss_function="RMSE",
        random_seed=42,
        verbose=False,
        early_stopping_rounds=40
    )


# ==========================================
# 3. ENSEMBLE TRAINING & VALIDATION PIPELINE
# ==========================================
def train_ensemble_pipeline():
    print("🌾 Loading engineered 25-year dataset...")
    df = pd.read_parquet(PARQUET_PATH)
    
    # Verify missing features
    missing = [f for f in FEATURES if f not in df.columns]
    if missing:
        raise KeyError(f"Missing required columns in dataset: {missing}")

    X = df[FEATURES]
    y = df[TARGET]

    print(f"📊 Training on {len(df):,} market records across {X.shape[1]} engineered features.")
    
    tscv = TimeSeriesSplit(n_splits=5)
    
    # Track out-of-fold predictions for meta-blender training
    oof_xgb = np.zeros(len(df))
    oof_lgb = np.zeros(len(df))
    oof_cat = np.zeros(len(df))
    
    val_indices = []

    print("\n🚀 Executing 5-Fold Walk-Forward Time-Series Validation...")
    
    for fold, (train_idx, val_idx) in enumerate(tscv.split(X)):
        print(f"\n--- Walk-Forward Fold {fold + 1}/5 ---")
        X_train, X_val = X.iloc[train_idx], X.iloc[val_idx]
        y_train, y_val = y.iloc[train_idx], y.iloc[val_idx]
        val_indices.extend(val_idx)

        # 1. Train XGBoost
        model_xgb = get_xgb_model()
        model_xgb.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=False)
        pred_xgb = model_xgb.predict(X_val)
        oof_xgb[val_idx] = pred_xgb
        print(f"  ✓ XGBoost Fold MAE:  {mean_absolute_error(y_val, pred_xgb) * 100:.2f}%")

        # 2. Train LightGBM
        model_lgb = get_lgb_model()
        model_lgb.fit(
            X_train, y_train,
            eval_set=[(X_val, y_val)],
            callbacks=[lgb.early_stopping(stopping_rounds=40, verbose=False)]
        )
        pred_lgb = model_lgb.predict(X_val)
        oof_lgb[val_idx] = pred_lgb
        print(f"  ✓ LightGBM Fold MAE: {mean_absolute_error(y_val, pred_lgb) * 100:.2f}%")

        # 3. Train CatBoost
        model_cat = get_cat_model()
        model_cat.fit(X_train, y_train, eval_set=(X_val, y_val), verbose=False)
        pred_cat = model_cat.predict(X_val)
        oof_cat[val_idx] = pred_cat
        print(f"  ✓ CatBoost Fold MAE: {mean_absolute_error(y_val, pred_cat) * 100:.2f}%")

    # ==========================================
    # 4. BLENDING & META-LEARNER OPTIMIZATION
    # ==========================================
    val_idx_arr = np.array(val_indices)
    y_val_all = y.iloc[val_idx_arr].values
    
    meta_features = np.column_stack([
        oof_xgb[val_idx_arr],
        oof_lgb[val_idx_arr],
        oof_cat[val_idx_arr]
    ])
    
    # Train Ridge Meta-Model to find optimal model weights (constrained positive)
    meta_blender = Ridge(alpha=1.0, positive=True, fit_intercept=False)
    meta_blender.fit(meta_features, y_val_all)
    weights = meta_blender.coef_
    normalized_weights = weights / np.sum(weights)

    blended_oof_preds = meta_features @ normalized_weights

    # ==========================================
    # 5. FINAL ACCURACY & DIRECTIONAL METRICS
    # ==========================================
    mae_xgb = mean_absolute_error(y_val_all, oof_xgb[val_idx_arr])
    mae_lgb = mean_absolute_error(y_val_all, oof_lgb[val_idx_arr])
    mae_cat = mean_absolute_error(y_val_all, oof_cat[val_idx_arr])
    mae_blend = mean_absolute_error(y_val_all, blended_oof_preds)
    
    rmse_blend = np.sqrt(mean_squared_error(y_val_all, blended_oof_preds))
    
    direction_actual = np.sign(y_val_all)
    direction_pred = np.sign(blended_oof_preds)
    mda_blend = np.mean(direction_actual == direction_pred) * 100

    print("\n" + "="*50)
    print("🏆 OUT-OF-FOLD BENCHMARK RESULTS")
    print("="*50)
    print(f"🔹 XGBoost Standalone MAE:       {mae_xgb * 100:.2f}%")
    print(f"🔹 LightGBM Standalone MAE:      {mae_lgb * 100:.2f}%")
    print(f"🔹 CatBoost Standalone MAE:      {mae_cat * 100:.2f}%")
    print(f"🔥 Blended Ensemble MAE:         {mae_blend * 100:.2f}%")
    print(f"🔥 Blended Ensemble RMSE:        {rmse_blend * 100:.2f}%")
    print(f"🔥 Mean Directional Accuracy:    {mda_blend:.2f}%")
    print("="*50)
    print("\n⚖️ Optimized Ensemble Weights:")
    print(f"  • XGBoost Weight:  {normalized_weights[0] * 100:.1f}%")
    print(f"  • LightGBM Weight: {normalized_weights[1] * 100:.1f}%")
    print(f"  • CatBoost Weight: {normalized_weights[2] * 100:.1f}%")

    # ==========================================
    # 6. EXPORT PRODUCTION ARTIFACTS
    # ==========================================
    print("\n💾 Exporting ensemble model artifacts...")
    model_xgb.save_model(os.path.join(MODEL_DIR, "xgb_model.json"))
    model_lgb.booster_.save_model(os.path.join(MODEL_DIR, "lgb_model.txt"))
    model_cat.save_model(os.path.join(MODEL_DIR, "cat_model.cbm"))
    
    joblib.dump({
        "weights": normalized_weights,
        "features": FEATURES,
        "mae_blend": mae_blend,
        "mda_blend": mda_blend
    }, os.path.join(MODEL_DIR, "ensemble_meta.joblib"))

    print(f"✅ All ensemble weights and models saved to '{MODEL_DIR}/'!")

if __name__ == "__main__":
    train_ensemble_pipeline()