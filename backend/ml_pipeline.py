"""
ml_pipeline.py — EnergyFlow Machine Learning Pipeline
=======================================================
Purpose:
  1. Export historical data from Firebase
  2. Detect voltage anomalies (Z-score + IQR method)
  3. Detect unusual power consumption (Isolation Forest)
  4. Classify load types (KMeans clustering)
  5. Predict high bill risk (Random Forest)
  6. Visualize patterns

Requirements:
  pip install firebase-admin pandas numpy scikit-learn matplotlib seaborn joblib

Usage:
  python ml_pipeline.py --mode train     # Train & save models
  python ml_pipeline.py --mode predict   # Run inference on recent data
  python ml_pipeline.py --mode export    # Just export data to CSV
"""

import os
import json
import base64
import argparse
import warnings
warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import matplotlib.gridspec as gridspec
import seaborn as sns

from sklearn.ensemble import IsolationForest, RandomForestClassifier
from sklearn.cluster import KMeans
from sklearn.preprocessing import StandardScaler
from sklearn.model_selection import train_test_split
from sklearn.model_selection import train_test_split
from sklearn.metrics import classification_report, confusion_matrix, mean_squared_error, r2_score
import joblib
import xgboost as xgb

# ============================================================
#  FIREBASE CONFIG
# ============================================================
import firebase_admin
from firebase_admin import credentials, db as firebase_db

def init_firebase():
    """Initialize Firebase with base64-encoded key from environment."""
    if firebase_admin._apps:
        return
    key_b64 = os.environ.get("FIREBASE_KEY_BASE64")
    if not key_b64:
        raise RuntimeError("Set FIREBASE_KEY_BASE64 environment variable")
    key_json = base64.b64decode(key_b64).decode("utf-8")
    cred_dict = json.loads(key_json)
    cred = credentials.Certificate(cred_dict)
    firebase_admin.initialize_app(cred, {
        "databaseURL": "https://energyflow-esp32-default-rtdb.firebaseio.com"
    })

# ============================================================
#  DATA EXPORT
# ============================================================
def export_data(device_id: str = "ESP001", save_csv: bool = True) -> pd.DataFrame:
    """
    Pull hourly analytics from Firebase and return as DataFrame.
    
    Schema of each row:
      hour, avg_voltage, avg_current, avg_power, energy_kwh, samples
    """
    init_firebase()
    ref = firebase_db.reference(f"devices/{device_id}/hourly")
    raw = ref.get()

    if not raw:
        print("⚠ No hourly data found. Make sure your device has sent data.")
        print("  Generating synthetic data for demonstration...")
        return generate_synthetic_data()

    rows = []
    for key, val in raw.items():
        count = val.get("count", 1)
        rows.append({
            "hour":          key,
            "timestamp":     val.get("timestamp", 0),
            "avg_voltage":   round(val.get("voltage_sum", 0) / count, 2),
            "avg_current":   round(val.get("current_sum", 0) / count, 4),
            "avg_power":     round(val.get("power_sum", 0) / count, 2),
            "energy_kwh":    round(max(0, val.get("energy_max", 0) - val.get("energy_min", 0)), 5),
            "samples":       count,
        })

    df = pd.DataFrame(rows).sort_values("hour").reset_index(drop=True)
    df["datetime"] = pd.to_datetime(df["hour"], format="%Y-%m-%d_%H")
    df["hour_of_day"] = df["datetime"].dt.hour
    df["day_of_week"]  = df["datetime"].dt.dayofweek
    df["is_weekend"]   = df["day_of_week"].isin([5, 6]).astype(int)

    if save_csv:
        df.to_csv("energy_data.csv", index=False)
        print(f"✓ Exported {len(df)} hourly records to energy_data.csv")

    return df

def generate_synthetic_data(days: int = 30) -> pd.DataFrame:
    """Generate realistic synthetic data for testing when no device data exists."""
    np.random.seed(42)
    rows = []

    for day in range(days):
        for hour in range(24):
            # Realistic household load pattern
            if 0 <= hour < 6:     base_power = 50 + np.random.normal(0, 10)   # Standby
            elif 6 <= hour < 9:   base_power = 800 + np.random.normal(0, 150) # Morning
            elif 9 <= hour < 17:  base_power = 300 + np.random.normal(0, 80)  # Day
            elif 17 <= hour < 21: base_power = 1500 + np.random.normal(0, 200)# Evening peak
            else:                 base_power = 200 + np.random.normal(0, 50)  # Night

            base_power = max(10, base_power)
            voltage = 230 + np.random.normal(0, 4)

            # Inject anomalies (~5%)
            is_anomaly = 0
            if np.random.rand() < 0.03:
                voltage = np.random.choice([200 + np.random.rand()*10, 248 + np.random.rand()*5])
                is_anomaly = 1
            if np.random.rand() < 0.02:
                base_power *= np.random.uniform(3, 8)
                is_anomaly = 1

            current = base_power / voltage
            energy  = base_power / 1000  # Approx 1 hour

            rows.append({
                "hour":         f"2025-{(day//30)+1:02d}-{(day%30)+1:02d}_{hour:02d}",
                "timestamp":    1700000000 + day * 86400 + hour * 3600,
                "avg_voltage":  round(voltage, 2),
                "avg_current":  round(current, 4),
                "avg_power":    round(base_power, 2),
                "energy_kwh":   round(energy, 5),
                "samples":      1200,
                "is_anomaly":   is_anomaly,
            })

    df = pd.DataFrame(rows)
    df["datetime"]   = pd.to_datetime(df["hour"], format="%Y-%m-%d_%H")
    df["hour_of_day"] = df["datetime"].dt.hour
    df["day_of_week"] = df["datetime"].dt.dayofweek
    df["is_weekend"]  = df["day_of_week"].isin([5, 6]).astype(int)
    print(f"✓ Generated {len(df)} synthetic rows ({days} days)")
    return df

# ============================================================
#  FEATURE ENGINEERING
# ============================================================
def engineer_features(df: pd.DataFrame) -> pd.DataFrame:
    """Add derived features for ML models."""
    df = df.copy()

    # Power factor estimate (if both current and voltage present)
    df["apparent_power"] = df["avg_voltage"] * df["avg_current"]
    df["power_factor"]   = np.where(df["apparent_power"] > 0, df["avg_power"] / df["apparent_power"], 1.0)
    df["power_factor"]   = df["power_factor"].clip(0, 1)

    # Rolling statistics (7-hour window)
    df["power_rolling_mean"]  = df["avg_power"].rolling(7, min_periods=1).mean()
    df["power_rolling_std"]   = df["avg_power"].rolling(7, min_periods=1).std().fillna(0)
    df["voltage_rolling_mean"] = df["avg_voltage"].rolling(7, min_periods=1).mean()

    # Z-scores
    df["voltage_zscore"] = (df["avg_voltage"] - df["avg_voltage"].mean()) / (df["avg_voltage"].std() + 1e-9)
    df["power_zscore"]   = (df["avg_power"] - df["avg_power"].mean()) / (df["avg_power"].std() + 1e-9)

    # Time features
    df["hour_sin"]  = np.sin(2 * np.pi * df["hour_of_day"] / 24)
    df["hour_cos"]  = np.cos(2 * np.pi * df["hour_of_day"] / 24)
    df["dow_sin"]   = np.sin(2 * np.pi * df["day_of_week"] / 7)
    df["dow_cos"]   = np.cos(2 * np.pi * df["day_of_week"] / 7)

    return df

# ============================================================
#  MODEL 1: VOLTAGE ANOMALY DETECTION
# ============================================================
def detect_voltage_anomalies(df: pd.DataFrame) -> pd.DataFrame:
    """
    Flag abnormal voltage using:
      1. Hard threshold: <210V or >250V
      2. IQR method: outside 1.5 * IQR from Q1/Q3
      3. Z-score: |z| > 2.5
    """
    V = df["avg_voltage"]
    Q1, Q3 = V.quantile(0.25), V.quantile(0.75)
    IQR = Q3 - Q1

    df["voltage_anomaly_hard"]   = ((V < 210) | (V > 250)).astype(int)
    df["voltage_anomaly_iqr"]    = ((V < Q1 - 1.5 * IQR) | (V > Q3 + 1.5 * IQR)).astype(int)
    df["voltage_anomaly_zscore"] = (df["voltage_zscore"].abs() > 2.5).astype(int)
    df["voltage_anomaly"]        = (df[["voltage_anomaly_hard", "voltage_anomaly_iqr", "voltage_anomaly_zscore"]].sum(axis=1) >= 2).astype(int)

    n = df["voltage_anomaly"].sum()
    pct = 100 * n / len(df)
    print(f"\n[Voltage Anomaly Detection]")
    print(f"  Total records:  {len(df)}")
    print(f"  Anomalies found: {n} ({pct:.1f}%)")
    if n > 0:
        print("  Sample anomalies:")
        print(df[df["voltage_anomaly"] == 1][["hour", "avg_voltage", "voltage_zscore"]].head(5).to_string(index=False))
    return df

# ============================================================
#  MODEL 2: POWER ANOMALY (ISOLATION FOREST)
# ============================================================
def train_power_anomaly_model(df: pd.DataFrame) -> IsolationForest:
    """
    Train Isolation Forest to detect unusual power consumption.
    Isolation Forest is unsupervised — no labels needed.
    """
    features = ["avg_power", "avg_current", "hour_of_day", "is_weekend",
                "power_rolling_mean", "power_rolling_std", "hour_sin", "hour_cos"]

    X = df[features].fillna(0)
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    model = IsolationForest(
        n_estimators=200,
        contamination=0.05,    # Expect ~5% anomalies
        random_state=42,
        n_jobs=-1
    )
    model.fit(X_scaled)
    scores = model.decision_function(X_scaled)

    df["power_anomaly_score"] = scores
    df["power_anomaly"]       = (model.predict(X_scaled) == -1).astype(int)

    n = df["power_anomaly"].sum()
    print(f"\n[Power Anomaly — Isolation Forest]")
    print(f"  Anomalies detected: {n} ({100*n/len(df):.1f}%)")

    # Save scaler + model
    joblib.dump({"model": model, "scaler": scaler, "features": features}, "models/power_anomaly.pkl")
    print("  ✓ Saved to models/power_anomaly.pkl")

    return model

# ============================================================
#  MODEL 3: LOAD CLASSIFICATION (KMeans)
# ============================================================
def classify_load_types(df: pd.DataFrame, n_clusters: int = 4) -> pd.DataFrame:
    """
    Cluster hours into load categories using KMeans:
      0: Standby/Night   (low power, low current)
      1: Light Load      (fans, lights, TV)
      2: Medium Load     (AC, fridge + more)
      3: Heavy Load      (cooking, EV charging, all on)
    """
    features = ["avg_power", "avg_current", "hour_of_day"]
    X = df[features].fillna(0)
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    km = KMeans(n_clusters=n_clusters, random_state=42, n_init=10)
    df["load_cluster"] = km.fit_predict(X_scaled)

    # Name clusters by avg power
    cluster_power = df.groupby("load_cluster")["avg_power"].mean().sort_values()
    label_map = {old: new for new, old in enumerate(cluster_power.index)}
    df["load_label"] = df["load_cluster"].map(label_map)

    labels = ["Standby", "Light Load", "Medium Load", "Heavy Load"]
    df["load_type"] = df["load_label"].map({i: l for i, l in enumerate(labels)})

    print(f"\n[Load Clustering — KMeans k={n_clusters}]")
    print(df.groupby("load_type")["avg_power"].agg(["count", "mean", "min", "max"]).round(1).to_string())

    joblib.dump({"model": km, "scaler": scaler, "features": features, "label_map": label_map}, "models/load_cluster.pkl")
    print("  ✓ Saved to models/load_cluster.pkl")

    return df

# ============================================================
#  MODEL 4: HIGH BILL PREDICTOR (Random Forest)
# ============================================================
def train_bill_predictor(df: pd.DataFrame):
    """
    Binary classifier: Will this billing period result in a high bill?
    High bill = total units in 30-day window > 300 kWh (Slab 3+)
    
    Since we predict per-hour, we use a rolling 720-hour (30-day)
    energy sum to create the label.
    """
    df = df.copy()
    df["energy_30d"] = df["energy_kwh"].rolling(720, min_periods=1).sum()
    df["high_bill"]  = (df["energy_30d"] > 300).astype(int)

    feature_cols = [
        "avg_power", "avg_voltage", "avg_current", "energy_kwh",
        "hour_of_day", "day_of_week", "is_weekend",
        "power_rolling_mean", "power_rolling_std",
        "hour_sin", "hour_cos", "dow_sin", "dow_cos", "power_factor"
    ]

    X = df[feature_cols].fillna(0)
    y = df["high_bill"]

    if y.sum() < 5 or (1 - y).sum() < 5:
        print("\n[High Bill Predictor] Not enough class variation — skipping training.")
        print("  (Need at least 5 samples of each class)")
        return None

    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)

    scaler = StandardScaler()
    X_train_s = scaler.fit_transform(X_train)
    X_test_s  = scaler.transform(X_test)

    clf = RandomForestClassifier(n_estimators=200, max_depth=8, random_state=42, n_jobs=-1)
    clf.fit(X_train_s, y_train)

    y_pred = clf.predict(X_test_s)
    print(f"\n[High Bill Predictor — Random Forest]")
    print(classification_report(y_test, y_pred, target_names=["Normal Bill", "High Bill"]))

    # Feature importance
    importances = pd.Series(clf.feature_importances_, index=feature_cols).sort_values(ascending=False)
    print("  Top 5 features:")
    print(importances.head(5).to_string())

    joblib.dump({"model": clf, "scaler": scaler, "features": feature_cols}, "models/bill_predictor.pkl")
    print("  ✓ Saved to models/bill_predictor.pkl")

    return clf

# ============================================================
#  MODEL 5: POWER FORECASTING (PyTorch Neural Network)
# ============================================================
def train_forecasting_model(df: pd.DataFrame):
    """
    Train a PyTorch neural network to predict avg_power for the next 24 hours.
    Uses the past 24 hours of avg_power as features.
    Saves the model weights as a .pth file as requested.
    """
    try:
        import torch
        import torch.nn as nn
        import torch.optim as optim
    except ImportError:
        print("\n[Power Forecaster] PyTorch not installed. Install with: pip install torch")
        return None

    df = df.copy().sort_values("datetime").reset_index(drop=True)
    
    # Create lag features (t-1 to t-23 and current t as lag_0)
    for i in range(1, 24):
        df[f'power_lag_{i}'] = df['avg_power'].shift(i)
    df['power_lag_0'] = df['avg_power']
    
    # Predict next 24 hours (t+1 to t+24)
    target_cols = []
    for i in range(1, 25):
        col = f'power_lead_{i}'
        df[col] = df['avg_power'].shift(-i)
        target_cols.append(col)
        
    feature_cols = [f'power_lag_{i}' for i in range(0, 24)] + ['hour_of_day', 'day_of_week', 'is_weekend']
    
    df_clean = df.dropna(subset=feature_cols + target_cols).copy()
    
    if len(df_clean) < 50:
        print("\n[Power Forecaster] Not enough data to train forecaster (need >50 hours after shifting).")
        return None
        
    X = df_clean[feature_cols].values
    Y = df_clean[target_cols].values
    
    # Time-series split (don't shuffle)
    split_idx = int(len(X) * 0.9)
    X_train, X_test = X[:split_idx], X[split_idx:]
    Y_train, Y_test = Y[:split_idx], Y[split_idx:]
    
    # Scale Data
    scaler_X = StandardScaler()
    scaler_Y = StandardScaler()
    
    X_train_s = scaler_X.fit_transform(X_train)
    X_test_s = scaler_X.transform(X_test)
    Y_train_s = scaler_Y.fit_transform(Y_train)
    Y_test_s = scaler_Y.transform(Y_test)

    # Convert to PyTorch Tensors
    X_train_t = torch.tensor(X_train_s, dtype=torch.float32)
    Y_train_t = torch.tensor(Y_train_s, dtype=torch.float32)
    X_test_t = torch.tensor(X_test_s, dtype=torch.float32)
    Y_test_t = torch.tensor(Y_test_s, dtype=torch.float32)

    # Define simple Feedforward Network
    class PowerForecasterNet(nn.Module):
        def __init__(self, input_size, output_size):
            super(PowerForecasterNet, self).__init__()
            self.fc1 = nn.Linear(input_size, 64)
            self.relu = nn.ReLU()
            self.fc2 = nn.Linear(64, 64)
            self.fc3 = nn.Linear(64, output_size)

        def forward(self, x):
            x = self.relu(self.fc1(x))
            x = self.relu(self.fc2(x))
            x = self.fc3(x)
            return x

    model = PowerForecasterNet(input_size=len(feature_cols), output_size=24)
    criterion = nn.MSELoss()
    optimizer = optim.Adam(model.parameters(), lr=0.005)

    print("\n[Power Forecaster — PyTorch Neural Network]")
    print("  Training for 100 epochs...")
    
    epochs = 100
    for epoch in range(epochs):
        model.train()
        optimizer.zero_grad()
        outputs = model(X_train_t)
        loss = criterion(outputs, Y_train_t)
        loss.backward()
        optimizer.step()

    model.eval()
    with torch.no_grad():
        test_outputs = model(X_test_t)
        test_loss = criterion(test_outputs, Y_test_t)
        
        # Calculate R^2 score manually
        y_mean = torch.mean(Y_test_t, dim=0)
        ss_tot = torch.sum((Y_test_t - y_mean) ** 2)
        ss_res = torch.sum((Y_test_t - test_outputs) ** 2)
        r2 = 1 - ss_res / ss_tot
        
    print(f"  Test MSE Loss: {test_loss.item():.4f}")
    print(f"  Test R^2 Score: {r2.item():.3f}")
    
    # Save the PyTorch Model state dict as .pth
    os.makedirs("models", exist_ok=True)
    torch.save(model.state_dict(), "models/power_forecaster.pth")
    
    # Also save the scalers and features utilizing joblib, as PyTorch expects just model weights
    joblib.dump({
        "scaler_X": scaler_X, 
        "scaler_Y": scaler_Y, 
        "features": feature_cols,
        "input_size": len(feature_cols),
        "output_size": 24
    }, "models/power_forecaster_meta.pkl")

    print("  ✓ Saved model weights to models/power_forecaster.pth")
    print("  ✓ Saved scalers to models/power_forecaster_meta.pkl")
    return model

# ============================================================
#  MODEL 6: POWER FORECASTING (XGBoost)
# ============================================================
def train_xgboost_forecaster(df: pd.DataFrame):
    """
    Train an XGBoost regressor to predict avg_power for the next hour (t+1).
    Uses the past 24 hours of avg_power as lag features.
    """
    df = df.copy().sort_values("datetime").reset_index(drop=True)
    
    # Create lag features (t-1 to t-24)
    for i in range(1, 25):
        df[f'power_lag_{i}'] = df['avg_power'].shift(i)
    
    # Target: power at t+1
    df['target_power'] = df['avg_power'].shift(-1)
    
    feature_cols = [f'power_lag_{i}' for i in range(1, 25)] + ['avg_power', 'hour_of_day', 'day_of_week', 'is_weekend']
    
    df_clean = df.dropna(subset=feature_cols + ['target_power']).copy()
    
    if len(df_clean) < 50:
        print("\n[XGBoost Forecaster] Not enough data to train forecaster (need >50 hours after shifting).")
        return None
        
    X = df_clean[feature_cols].values
    y = df_clean['target_power'].values
    
    # Time-series split (don't shuffle)
    split_idx = int(len(X) * 0.9)
    X_train, X_test = X[:split_idx], X[split_idx:]
    y_train, y_test = y[:split_idx], y[split_idx:]
    
    model = xgb.XGBRegressor(
        n_estimators=500,
        learning_rate=0.05,
        max_depth=6,
        subsample=0.8,
        colsample_bytree=0.8,
        random_state=42,
        n_jobs=-1,
        early_stopping_rounds=50
    )
    
    print("\n[Power Forecaster — XGBoost]")
    print(f"  Training on {len(X_train)} samples, testing on {len(X_test)} samples...")
    model.fit(
        X_train, y_train,
        eval_set=[(X_test, y_test)],
        verbose=False
    )
    
    y_pred = model.predict(X_test)
    mse = mean_squared_error(y_test, y_pred)
    r2 = r2_score(y_test, y_pred)
    
    print(f"  Test MSE: {mse:.2f}")
    print(f"  Test R^2: {r2:.3f}")
    
    # Feature importance
    importances = pd.Series(model.feature_importances_, index=feature_cols).sort_values(ascending=False)
    print("  Top 5 features:")
    print(importances.head(5).to_string())

    joblib.dump({"model": model, "features": feature_cols}, "models/xgb_forecaster.pkl")
    print("  ✓ Saved model to models/xgb_forecaster.pkl")
    return model

# ============================================================
#  VISUALIZATIONS
# ============================================================
def plot_analysis(df: pd.DataFrame, save: bool = True):
    """Generate a comprehensive analysis dashboard."""
    plt.style.use("dark_background")
    colors = {"amber": "#fbbf24", "blue": "#38bdf8", "green": "#34d399", "red": "#f87171", "purple": "#a78bfa"}

    fig = plt.figure(figsize=(20, 16), facecolor="#060c14")
    gs = gridspec.GridSpec(3, 3, figure=fig, hspace=0.4, wspace=0.35)

    ax_style = {"facecolor": "#0d1626", "grid_alpha": 0.15}

    # 1. Power by Hour of Day
    ax1 = fig.add_subplot(gs[0, :2])
    ax1.set_facecolor(ax_style["facecolor"])
    hourly_avg = df.groupby("hour_of_day")["avg_power"].mean()
    ax1.bar(hourly_avg.index, hourly_avg.values, color=colors["amber"], alpha=0.8, edgecolor="none")
    ax1.set_title("Average Power by Hour of Day", color="#e2e8f0", fontsize=12, pad=10)
    ax1.set_xlabel("Hour", color="#64748b"); ax1.set_ylabel("Power (W)", color="#64748b")
    ax1.tick_params(colors="#64748b"); ax1.grid(alpha=ax_style["grid_alpha"], color="white")

    # 2. Voltage Distribution
    ax2 = fig.add_subplot(gs[0, 2])
    ax2.set_facecolor(ax_style["facecolor"])
    ax2.hist(df["avg_voltage"], bins=40, color=colors["blue"], alpha=0.8, edgecolor="none")
    ax2.axvline(220, color=colors["red"], linestyle="--", alpha=0.7, label="220V min")
    ax2.axvline(240, color=colors["red"], linestyle="--", alpha=0.7, label="240V max")
    ax2.set_title("Voltage Distribution", color="#e2e8f0", fontsize=12, pad=10)
    ax2.set_xlabel("Voltage (V)", color="#64748b"); ax2.set_ylabel("Count", color="#64748b")
    ax2.tick_params(colors="#64748b"); ax2.legend(fontsize=8)
    ax2.grid(alpha=ax_style["grid_alpha"], color="white")

    # 3. Power Time Series with Anomalies
    ax3 = fig.add_subplot(gs[1, :])
    ax3.set_facecolor(ax_style["facecolor"])
    ax3.plot(range(len(df)), df["avg_power"], color=colors["amber"], linewidth=0.8, alpha=0.9, label="Power (W)")
    if "power_anomaly" in df.columns:
        anom_idx = df[df["power_anomaly"] == 1].index
        ax3.scatter(anom_idx, df.loc[anom_idx, "avg_power"],
                   color=colors["red"], s=30, zorder=5, label=f"Anomaly ({len(anom_idx)})")
    if "voltage_anomaly" in df.columns:
        vanom_idx = df[df["voltage_anomaly"] == 1].index
        ax3_v = ax3.twinx()
        ax3_v.plot(range(len(df)), df["avg_voltage"], color=colors["blue"], linewidth=0.5, alpha=0.5)
        ax3_v.scatter(vanom_idx, df.loc[vanom_idx, "avg_voltage"],
                     color="#e879f9", s=25, marker="^", zorder=5)
        ax3_v.set_ylabel("Voltage (V)", color=colors["blue"]); ax3_v.tick_params(colors="#64748b")
    ax3.set_title("Power & Voltage Time Series with Anomalies", color="#e2e8f0", fontsize=12, pad=10)
    ax3.set_xlabel("Hour Index", color="#64748b"); ax3.set_ylabel("Power (W)", color="#64748b")
    ax3.tick_params(colors="#64748b"); ax3.legend(loc="upper right", fontsize=9)
    ax3.grid(alpha=ax_style["grid_alpha"], color="white")

    # 4. Load Type Distribution (if clustered)
    ax4 = fig.add_subplot(gs[2, 0])
    ax4.set_facecolor(ax_style["facecolor"])
    if "load_type" in df.columns:
        lt_counts = df["load_type"].value_counts()
        cluster_colors = [colors["blue"], colors["green"], colors["amber"], colors["red"]]
        ax4.pie(lt_counts.values, labels=lt_counts.index, colors=cluster_colors[:len(lt_counts)],
               autopct="%1.0f%%", textprops={"color": "#e2e8f0", "fontsize": 9})
        ax4.set_title("Load Type Distribution", color="#e2e8f0", fontsize=12, pad=10)
    else:
        ax4.text(0.5, 0.5, "Run classify_load_types()\nfirst", ha="center", va="center",
                color="#64748b", transform=ax4.transAxes)
        ax4.set_title("Load Types (not run)", color="#e2e8f0", fontsize=12)

    # 5. Daily Energy Heatmap (hour vs day-of-week)
    ax5 = fig.add_subplot(gs[2, 1:])
    ax5.set_facecolor(ax_style["facecolor"])
    if len(df) > 50:
        pivot = df.pivot_table(values="avg_power", index="day_of_week", columns="hour_of_day", aggfunc="mean")
        sns.heatmap(pivot, ax=ax5, cmap="YlOrRd", linewidths=0.1, linecolor="#060c14",
                   cbar_kws={"label": "Avg Power (W)"}, xticklabels=2)
        ax5.set_title("Power Heatmap (Day × Hour)", color="#e2e8f0", fontsize=12, pad=10)
        ax5.set_xlabel("Hour of Day", color="#64748b"); ax5.set_ylabel("Day of Week (0=Mon)", color="#64748b")
        ax5.tick_params(colors="#64748b")
    else:
        ax5.text(0.5, 0.5, "Need 50+ records for heatmap", ha="center", va="center",
                color="#64748b", transform=ax5.transAxes, fontsize=11)
        ax5.set_title("Power Heatmap", color="#e2e8f0", fontsize=12)

    fig.suptitle("EnergyFlow — ML Analysis Dashboard", color=colors["amber"], fontsize=16, fontweight="bold", y=1.01)

    if save:
        os.makedirs("output", exist_ok=True)
        plt.savefig("output/analysis_dashboard.png", dpi=150, bbox_inches="tight", facecolor=fig.get_facecolor())
        print("\n✓ Saved plot to output/analysis_dashboard.png")
    else:
        plt.show()
    plt.close()

# ============================================================
#  INFERENCE — Run on new data
# ============================================================
def run_inference(df: pd.DataFrame):
    """Load saved models and run inference on df."""
    df = engineer_features(df)
    results = {}

    # Power anomaly
    if os.path.exists("models/power_anomaly.pkl"):
        saved = joblib.load("models/power_anomaly.pkl")
        X = df[saved["features"]].fillna(0)
        X_s = saved["scaler"].transform(X)
        df["power_anomaly"] = (saved["model"].predict(X_s) == -1).astype(int)
        results["power_anomalies"] = int(df["power_anomaly"].sum())
        print(f"Power anomalies detected: {results['power_anomalies']}")

    # Load cluster
    if os.path.exists("models/load_cluster.pkl"):
        saved = joblib.load("models/load_cluster.pkl")
        X = df[saved["features"]].fillna(0)
        X_s = saved["scaler"].transform(X)
        raw_labels = saved["model"].predict(X_s)
        df["load_cluster"] = [saved["label_map"].get(l, 0) for l in raw_labels]
        labels = ["Standby", "Light Load", "Medium Load", "Heavy Load"]
        df["load_type"] = df["load_cluster"].map({i: l for i, l in enumerate(labels)})
        results["load_distribution"] = df["load_type"].value_counts().to_dict()
        print("Load distribution:", results["load_distribution"])

    # Bill predictor
    if os.path.exists("models/bill_predictor.pkl"):
        saved = joblib.load("models/bill_predictor.pkl")
        X = df[saved["features"]].fillna(0)
        X_s = saved["scaler"].transform(X)
        proba = saved["model"].predict_proba(X_s)[:, 1]
        results["high_bill_probability"] = float(proba.mean())
        print(f"High bill probability: {results['high_bill_probability']*100:.1f}%")

    # XGBoost Forecaster
    if os.path.exists("models/xgb_forecaster.pkl"):
        saved = joblib.load("models/xgb_forecaster.pkl")
        model = saved["model"]
        feature_cols = saved["features"]
        
        # We need the last 25 hours to create the 24 lag features + current power
        if len(df) >= 25:
            recent_df = df.copy().sort_values("datetime").tail(25).reset_index(drop=True)
            
            # Predict the "next hour" after the extremely last hour in the dataset
            # Feature dict
            feat_dict = {}
            # Current power is the very last recorded power
            current_idx = len(recent_df) - 1
            feat_dict['avg_power'] = recent_df.loc[current_idx, 'avg_power']
            feat_dict['hour_of_day'] = (recent_df.loc[current_idx, 'datetime'] + pd.Timedelta(hours=1)).hour
            feat_dict['day_of_week'] = (recent_df.loc[current_idx, 'datetime'] + pd.Timedelta(hours=1)).dayofweek
            feat_dict['is_weekend'] = 1 if feat_dict['day_of_week'] in [5, 6] else 0
            
            for i in range(1, 25): # lag_1 to lag_24
                # lag_1 is the power 1 step before current, which is index `current_idx - i + 1`?
                # Actually, in training: power_lag_1 = df['avg_power'].shift(1)
                # So if predicting t+1, lag_1 is actually 'current' power (t).
                # lag_2 is t-1, etc.
                if i == 1:
                    feat_dict[f'power_lag_{i}'] = recent_df.loc[current_idx, 'avg_power']
                else:
                    target_idx = current_idx - (i - 1)
                    feat_dict[f'power_lag_{i}'] = recent_df.loc[target_idx, 'avg_power']
            
            # Convert dictionary to DataFrame for prediction
            X_pred = pd.DataFrame([feat_dict], columns=feature_cols).values
            prediction = model.predict(X_pred)[0]
            
            results["next_hour_power_prediction_w"] = float(prediction)
            print(f"XGBoost next hour predicted power: {prediction:.2f} W")
        else:
            print("Not enough recent data (need 25 hours) for XGBoost Inference.")

    return df, results

# ============================================================
#  MAIN
# ============================================================
def load_uci_dataset(path="uci_hourly.csv") -> pd.DataFrame:
    """Helper to load parsed UCI dataset."""
    if not os.path.exists(path):
        print(f"⚠ UCI dataset not found at {path}. Please run prep_uci_data.py first.")
        return pd.DataFrame()
        
    df = pd.read_csv(path)
    df["datetime"] = pd.to_datetime(df["hour"], format="%Y-%m-%d_%H")
    print(f"✓ Loaded {len(df)} records from {path}")
    return df

def main():
    parser = argparse.ArgumentParser(description="EnergyFlow ML Pipeline")
    parser.add_argument("--mode", choices=["train", "predict", "export"], default="train")
    parser.add_argument("--dataset", choices=["firebase", "uci"], default="firebase", help="Source of data for training")
    parser.add_argument("--device", default="ESP001")
    parser.add_argument("--days", type=int, default=1)
    args = parser.parse_args()

    os.makedirs("models", exist_ok=True)
    os.makedirs("output", exist_ok=True)

    print(f"\n{'='*50}")
    print(f"  EnergyFlow ML Pipeline — mode: {args.mode}")
    print(f"{'='*50}")

    if args.mode == "export":
        df = export_data(args.device)
        print(df.head())
        return

    # Load data
    if args.dataset == "uci":
        print("\nUsing UCI Dataset for training...")
        df = load_uci_dataset()
        if df.empty: return
    else:
        df = export_data(args.device)
        
    df = engineer_features(df)
    
    # We still need to fill rolling feature NAs that happen on the first few rows
    # rather than dropping them, to preserve data.
    # The actual columns are expected to be numeric now
    df.ffill(inplace=True)
    df.bfill(inplace=True)
    df.dropna(inplace=True)
    df.reset_index(drop=True, inplace=True)
    print(f"Data ready for training: {len(df)} records")

    if args.mode == "train":
        print("\n--- Voltage Anomaly Detection ---")
        df = detect_voltage_anomalies(df)

        print("\n--- Training Power Anomaly Model ---")
        train_power_anomaly_model(df)

        print("\n--- Load Classification ---")
        df = classify_load_types(df)

        print("\n--- Bill Predictor ---")
        train_bill_predictor(df)

        print("\n--- Power Forecasting (PyTorch) ---")
        train_forecasting_model(df)
        
        print("\n--- Power Forecasting (XGBoost) ---")
        train_xgboost_forecaster(df)

        print("\n--- Generating Plots ---")
        plot_analysis(df)

        print("\n✓ All models trained and saved to models/")
        print("✓ Run with --mode predict for inference on new data")

    elif args.mode == "predict":
        print("\n--- Running Inference ---")
        df, results = run_inference(df)
        print("\nResults summary:", json.dumps(results, indent=2))
        plot_analysis(df)

if __name__ == "__main__":
    main()
