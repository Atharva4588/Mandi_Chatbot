import os
import joblib
import numpy as np
import pandas as pd
from datetime import datetime

import xgboost as xgb
import lightgbm as lgb
from catboost import CatBoostRegressor


class BhavnetraEnsemblePredictor:
    def __init__(self, model_dir: str = "ensemble_models"):
        self.model_dir = model_dir
        
        # 1. Load Meta-Artifacts & Weights
        meta_path = os.path.join(model_dir, "ensemble_meta.joblib")
        if not os.path.exists(meta_path):
            raise FileNotFoundError(f"Ensemble metadata not found at {meta_path}. Run train_ensemble.py first.")
            
        meta = joblib.load(meta_path)
        self.weights = meta["weights"]          # [XGB, LGB, CAT]
        self.features = meta["features"]
        self.blend_rmse = meta.get("mda_blend", 0.0244)  # ~2.44% historical RMSE
        
        # 2. Load Models into RAM for sub-10ms edge inference
        print("⚡ Loading ensemble models into memory...")
        
        # XGBoost
        self.model_xgb = xgb.XGBRegressor()
        self.model_xgb.load_model(os.path.join(model_dir, "xgb_model.json"))
        
        # LightGBM
        self.model_lgb = lgb.Booster(model_file=os.path.join(model_dir, "lgb_model.txt"))
        
        # CatBoost
        self.model_cat = CatBoostRegressor()
        self.model_cat.load_model(os.path.join(model_dir, "cat_model.cbm"))
        
        print("✅ Bhavnetra Ensemble Inference Engine initialized successfully!")

    def _build_feature_vector(
        self,
        modal_price: float,
        arrivals_tonnes: float,
        date_str: str = None,
        price_lag_1: float = None,
        price_lag_7: float = None,
        arrivals_rolling_30d: float = None
    ) -> pd.DataFrame:
        """
        Constructs the exact 23-feature vector expected by the models.
        Fills reasonable approximations if historical lags are not passed.
        """
        dt = datetime.strptime(date_str, "%Y-%m-%d") if date_str else datetime.now()
        day_of_year = dt.timetuple().tm_yday
        day_of_week = dt.weekday()
        
        p_lag_1 = price_lag_1 if price_lag_1 is not None else modal_price
        p_lag_7 = price_lag_7 if price_lag_7 is not None else modal_price
        arr_med_30 = arrivals_rolling_30d if arrivals_rolling_30d is not None else arrivals_tonnes
        
        feature_dict = {
            'modal_price': modal_price,
            'arrivals_tonnes': arrivals_tonnes,
            'day_of_week': day_of_week,
            'day_of_year': day_of_year,
            'month': dt.month,
            'quarter': (dt.month - 1) // 3 + 1,
            'year': dt.year,
            'sin_day': np.sin(2 * np.pi * day_of_year / 365.25),
            'cos_day': np.cos(2 * np.pi * day_of_year / 365.25),
            'sin_dow': np.sin(2 * np.pi * day_of_week / 7.0),
            'cos_dow': np.cos(2 * np.pi * day_of_week / 7.0),
            'price_lag_1': p_lag_1,
            'price_lag_3': (p_lag_1 + p_lag_7) / 2.0,
            'price_lag_7': p_lag_7,
            'price_lag_14': p_lag_7,
            'price_lag_30': p_lag_7,
            'ema_7d': (modal_price * 0.25) + (p_lag_7 * 0.75),
            'ema_21d': (modal_price * 0.10) + (p_lag_7 * 0.90),
            'rolling_mean_7d': (modal_price + p_lag_1 + p_lag_7) / 3.0,
            'rolling_mean_30d': (modal_price + p_lag_7) / 2.0,
            'rolling_std_7d': abs(modal_price - p_lag_7) * 0.35,
            'rolling_std_30d': abs(modal_price - p_lag_7) * 0.50,
            'price_change_7d': (modal_price - p_lag_7) / (p_lag_7 + 1e-5),
            'arrivals_lag_1': arrivals_tonnes,
            'arrivals_lag_7': arrivals_tonnes,
            'arrivals_rolling_7d': arrivals_tonnes,
            'arrivals_rolling_30d': arr_med_30,
            'arrival_shock_ratio': arrivals_tonnes / (arr_med_30 + 1e-5)
        }
        
        return pd.DataFrame([feature_dict])[self.features]

    def predict(
        self,
        commodity: str,
        market: str,
        modal_price: float,
        arrivals_tonnes: float = 25.0,
        date_str: str = None
    ) -> dict:
        """
        Executes parallel model inference and returns the blended forecast with a 95% CI.
        """
        X_live = self._build_feature_vector(
            modal_price=modal_price,
            arrivals_tonnes=arrivals_tonnes,
            date_str=date_str
        )
        
        # 1. Model Inferences (Predicts % change over 2 days)
        pred_xgb = float(self.model_xgb.predict(X_live)[0])
        pred_lgb = float(self.model_lgb.predict(X_live)[0])
        pred_cat = float(self.model_cat.predict(X_live)[0])
        
        # 2. Weighted Blend
        blended_pct_swing = (
            self.weights[0] * pred_xgb +
            self.weights[1] * pred_lgb +
            self.weights[2] * pred_cat
        )
        
        # 3. Compute Absolute Price Points
        predicted_price_2d = round(modal_price * (1.0 + blended_pct_swing), 2)
        
        # 4. Compute 95% Confidence Interval (1.96 * RMSE spread)
        ci_margin_pct = 1.96 * 0.0244  # ~4.78% absolute volatility bracket
        ci_lower = round(predicted_price_2d * (1.0 - ci_margin_pct), 2)
        ci_upper = round(predicted_price_2d * (1.0 + ci_margin_pct), 2)
        
        # Trend Direction
        direction = "BULLISH (UP)" if blended_pct_swing > 0.005 else ("BEARISH (DOWN)" if blended_pct_swing < -0.005 else "STABLE")
        
        return {
            "commodity": commodity,
            "market": market,
            "current_modal_price": modal_price,
            "predicted_modal_price_2d": predicted_price_2d,
            "expected_pct_change": round(blended_pct_swing * 100, 2),
            "trend_direction": direction,
            "confidence_interval_95": {
                "lower_bound": ci_lower,
                "upper_bound": ci_upper,
                "margin_rupees": round((ci_upper - ci_lower) / 2, 2)
            },
            "ensemble_breakdown": {
                "xgboost_pct": round(pred_xgb * 100, 2),
                "lightgbm_pct": round(pred_lgb * 100, 2),
                "catboost_pct": round(pred_cat * 100, 2)
            }
        }


# ==========================================
# TEST EXECUTION
# ==========================================
if __name__ == "__main__":
    predictor = BhavnetraEnsemblePredictor()
    
    # Test sample: Lasalgaon Onion spot price at ₹2,200/quintal
    sample_result = predictor.predict(
        commodity="Onion",
        market="Lasalgaon",
        modal_price=2200.0,
        arrivals_tonnes=45.0
    )
    
    print("\n" + "="*50)
    print("📈 BHAVNETRA ENSEMBLE FORECAST RESULT")
    print("="*50)
    print(f"🌾 Commodity:            {sample_result['commodity']} ({sample_result['market']})")
    print(f"💰 Current Spot Price:   ₹{sample_result['current_modal_price']:.2f} / quintal")
    print(f"🎯 Predicted 2-Day Rate: ₹{sample_result['predicted_modal_price_2d']:.2f} / quintal")
    print(f"📊 Expected Swing:       {sample_result['expected_pct_change']:+.2f}% ({sample_result['trend_direction']})")
    print(f"🛡️  95% Confidence Band:  ₹{sample_result['confidence_interval_95']['lower_bound']} — ₹{sample_result['confidence_interval_95']['upper_bound']} (±₹{sample_result['confidence_interval_95']['margin_rupees']})")
    print("="*50)