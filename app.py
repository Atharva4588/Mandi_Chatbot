from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List, Optional
import os
from predict_ensemble import BhavnetraEnsemblePredictor

app = FastAPI(
    title="भावनेत्र 25-Year Ensemble & Procurement Engine",
    version="3.0.0"
)

# 1. Initialize Ensemble Predictor into RAM on Startup
MODEL_DIR = os.path.join(os.path.dirname(__file__), "ensemble_models")
try:
    predictor = BhavnetraEnsemblePredictor(model_dir=MODEL_DIR)
    print("✅ Successfully loaded Bhavnetra 3-Model Ensemble (XGB + LGBM + CatBoost)!")
except Exception as e:
    print(f"⚠️ Warning: Could not initialize ensemble ({e}). Check ensemble_models/ folder.")
    predictor = None


# ==========================================
# 2. REQUEST SCHEMAS
# ==========================================
class PriceHistoryRequest(BaseModel):
    mandiName: str
    commodity: str
    currentPrice: float
    prices: List[float] = []
    arrivalsTonnes: float = 45.0


class DynamicQuoteRequest(BaseModel):
    commodity: str
    market: str
    current_modal_price: float
    floor_price: float
    distance_km: float = 30.0
    quantity_quintals: float = 100.0
    grade: str = "Grade A"  # Grade A | Grade B | Grade C


# ==========================================
# 3. ENDPOINTS
# ==========================================
@app.get("/")
def read_root():
    return {
        "status": "online",
        "service": "भावनेत्र Procurement & Forecasting Engine",
        "engine": "XGBoost (26.1%) + LightGBM (58.6%) + CatBoost (15.3%)",
        "ensemble_loaded": predictor is not None
    }


@app.post("/predict")
def predict_price_trend(data: PriceHistoryRequest):
    if data.currentPrice <= 0:
        raise HTTPException(status_code=400, detail="Current price must be greater than 0")

    if predictor is None:
        raise HTTPException(status_code=500, detail="Ensemble predictor models are not loaded.")

    # Historical lag metrics
    price_lag_1 = data.prices[-1] if len(data.prices) >= 1 else data.currentPrice
    price_lag_7 = data.prices[-7] if len(data.prices) >= 7 else data.currentPrice

    # Run blended ensemble inference
    res = predictor.predict(
        commodity=data.commodity,
        market=data.mandiName,
        modal_price=data.currentPrice,
        arrivals_tonnes=data.arrivalsTonnes
    )

    predicted_price_day2 = res["predicted_modal_price_2d"]
    percent_change = res["expected_pct_change"]
    price_diff = round(predicted_price_day2 - data.currentPrice, 2)
    ci = res["confidence_interval_95"]

    # Farmer decision heuristics
    if percent_change >= 2.5:
        recommendation = "🚀 HOLD 2 DAYS"
        advice = f"Surge expected (+{percent_change}%). Holding can yield ~₹{price_diff}/q more."
    elif percent_change <= -2.5:
        recommendation = "⚡ SELL TODAY"
        advice = f"Price drop expected ({percent_change}%). Dispatching today avoids market dips."
    else:
        recommendation = "⚖️ STABLE MARKET"
        advice = f"Stable trend ({percent_change:+.2f}%). Proceed with standard harvest schedule."

    return {
        "mandiName": data.mandiName,
        "commodity": data.commodity,
        "currentPrice": data.currentPrice,
        "predictedPriceDay2": predicted_price_day2,
        "priceDiff": price_diff,
        "percentChange": percent_change,
        "confidenceInterval": {
            "lowerBound": ci["lower_bound"],
            "upperBound": ci["upper_bound"]
        },
        "recommendation": recommendation,
        "advice": advice,
        "modelUsed": "BhavNetra 25-Year Weighted Ensemble (LGBM 58.6%, XGB 26.1%, CAT 15.3%)"
    }


@app.post("/dynamic-quote")
def get_dynamic_procurement_quote(req: DynamicQuoteRequest):
    if req.current_modal_price <= 0 or req.floor_price <= 0:
        raise HTTPException(status_code=400, detail="Prices must be greater than 0")

    # Run inference for market expected direction
    forecast = predictor.predict(
        commodity=req.commodity,
        market=req.market,
        modal_price=req.current_modal_price
    )
    p_index = forecast["predicted_modal_price_2d"]

    # Dynamic pricing formula execution
    diesel_rate_per_km = 3.50
    c_logistics = round((req.distance_km * diesel_rate_per_km * 1.35) / max(req.quantity_quintals, 1.0), 2)
    c_handling = 40.0

    # 50% Upside sharing above guaranteed floor
    alpha = 0.50
    upside = alpha * max(0.0, req.current_modal_price - req.floor_price)

    # Grade premium / discount
    grade_multiplier = 0.08 if req.grade == "Grade A" else (0.0 if req.grade == "Grade B" else -0.12)
    q_premium = round(req.floor_price * grade_multiplier, 2)

    base_adjusted = p_index - c_logistics + upside
    p_farmer = round(max(req.floor_price, base_adjusted) + q_premium, 2)

    platform_margin = 120.0
    p_buyer = round(p_farmer + c_logistics + c_handling + platform_margin, 2)

    return {
        "commodity": req.commodity,
        "market": req.market,
        "grade": req.grade,
        "farmer_payout_per_quintal": p_farmer,
        "total_farmer_settlement": round(p_farmer * req.quantity_quintals, 2),
        "corporate_invoice_per_quintal": p_buyer,
        "total_corporate_billing": round(p_buyer * req.quantity_quintals, 2),
        "breakdown": {
            "floor_price": req.floor_price,
            "mandi_spot": req.current_modal_price,
            "upside_share": round(upside, 2),
            "quality_premium": q_premium,
            "logistics_cost": c_logistics,
            "platform_margin": platform_margin
        }
    }