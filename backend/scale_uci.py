import pandas as pd
df = pd.read_csv('uci_hourly.csv')
if df['avg_power'].mean() < 20: # Make sure we don't scale twice if it's already in Watts!
    df['avg_power'] = (df['avg_power'] * 1000).round(2)
    df.to_csv('uci_hourly.csv', index=False)
    print("Scaled uci_hourly.csv avg_power to Watts.")
else:
    print("Already in Watts based on mean > 20.")
