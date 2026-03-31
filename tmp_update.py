import os
import re

def update_index():
    path = r'c:\Madhusudhan\Visual Studio Code\MDP\Electric_Meter_in_web\frontend\index.html'
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # Remove ROW 1 to 3
    # Starts at <!-- ROW 1: Monthly Forecast + Bill Risk -->
    # Ends right before <!-- ROW 4: NILM — Appliance Disaggregation -->
    
    start_str = "<!-- ROW 1: Monthly Forecast + Bill Risk -->"
    end_str = "<!-- ROW 4: NILM — Appliance Disaggregation -->"
    
    idx_start = content.find(start_str)
    idx_end = content.find(end_str)
    
    if idx_start != -1 and idx_end != -1:
        content = content[:idx_start] + content[idx_end:]
    
    # Rename rows
    content = content.replace("ROW 4: NILM", "ROW 1: NILM")
    content = content.replace("ROW 5: Energy Cost Calculator", "ROW 2: Energy Cost Calculator")
    content = content.replace("ROW 6: Voltage Fluctuation Predictor", "ROW 3: Voltage Fluctuation Predictor")

    # Update Page Title
    content = content.replace("AI Predictions", "AI Insights")
    content = content.replace("All 9 ML models — from localized anomaly detection to XGBoost forecasting.", "Predictive Billing, Appliance Health & Grid Stability")

    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)
    print("Updated index.html")

def update_app_js():
    path = r'c:\Madhusudhan\Visual Studio Code\MDP\Electric_Meter_in_web\frontend\app.js'
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()

    # 1. Update runMLInference to just be empty or removed from loadStatisticsPage
    content = content.replace("runMLInference(filtered);", "// Legacy inference removed")
    
    # Also replace it if there are other occurrences (e.g., where 'api("/ml/anomalies...")' was called)
    content = content.replace('api(`/ml/anomalies?days=${days}`),', '')
    content = content.replace('const [summary, hourly, anomalies]', 'const [summary, hourly]')
    
    # 2. Update loadPredictionPage
    str_to_replace = """window.loadPredictionPage = async () => {
  await Promise.allSettled([
    fetchMonthlyPrediction(),
    fetchBillRisk(),
    fetchLoadType(),
    fetchForecast(),
    fetchIFAnomalies(),
    fetchNilm(),
    fetchEnergyCost(),
    fetchVoltageFluctuation(),
  ]);
};"""
    
    new_load = """window.loadPredictionPage = async () => {
  await Promise.allSettled([
    fetchEnergyCost(),
    fetchNilm(),
    fetchVoltageFluctuation(),
  ]);
};"""
    content = content.replace(str_to_replace, new_load)

    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)
    print("Updated app.js")

if __name__ == "__main__":
    update_index()
    update_app_js()
