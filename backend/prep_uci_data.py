import pandas as pd
import numpy as np
import os
import argparse

def prep_uci_data(input_file: str, output_file: str):
    """
    Parses the massive UCI Household Electric Power Consumption dataset 
    from a per-minute resolution down to an hourly resolution that 
    matches our EnergyFlow schema.
    """
    print(f"Loading UCI dataset from {input_file} (This may take a moment...)")
    
    # Just load normally, handling ? as NA
    df = pd.read_csv(input_file, sep=';', na_values=['?'])
    
    print("Parsing datetime...")
    df['datetime'] = pd.to_datetime(df['Date'] + ' ' + df['Time'], format="%d/%m/%Y %H:%M:%S", dayfirst=True)
    
    print("Dropping NA values...")
    cols_to_convert = ['Global_active_power', 'Global_reactive_power', 'Voltage', 'Global_intensity']
    df.dropna(subset=cols_to_convert, inplace=True)




    print("Resampling to hourly aggregations...")
    df.set_index('datetime', inplace=True)
    
    # Rename columns to match what `ml_pipeline.py` expects
    df.rename(columns={
        'Global_active_power': 'avg_power',
        'Global_reactive_power': 'avg_reactive_power',
        'Voltage': 'avg_voltage',
        'Global_intensity': 'avg_current'
    }, inplace=True)
    
    hourly = df.resample('H').agg({
        'avg_power': 'mean', # mean kW over the hour
        'avg_voltage': 'mean',             # mean V over the hour
        'avg_current': 'mean'     # mean A over the hour
    })
    
    # Drop hours where there was entirely missing data in the original
    hourly.dropna(inplace=True)
    
    # Map back to our EnergyFlow schema:
    # "hour", "timestamp", "avg_voltage", "avg_current", "avg_power", "energy_kwh", "samples"
    
    out_df = pd.DataFrame(index=hourly.index)
    
    # 3. Create the required features using the expected names
    # Note: `hourly` uses the new renamed columns already
    out_df['hour'] = hourly.index.strftime('%Y-%m-%d_%H')
    out_df['timestamp'] = (hourly.index - pd.Timestamp("1970-01-01")) // pd.Timedelta('1s')
    
    out_df['avg_voltage'] = hourly['avg_voltage'].round(2)
    out_df['avg_current'] = hourly['avg_current'].round(2)
    out_df['avg_power'] = hourly['avg_power'].round(3)
    
    # Energy = Power (kW) * 1 hour = kWh
    out_df['energy_kwh'] = out_df['avg_power'].round(3) 
    out_df['samples'] = 60 # Original is 1-minute tracking
    
    out_df['hour_of_day'] = hourly.index.hour
    out_df['day_of_week'] = hourly.index.dayofweek
    out_df['is_weekend'] = out_df['day_of_week'].isin([5, 6]).astype(int)
    
    out_df.sort_values('hour', inplace=True)
    
    print(f"Exporting exactly {len(out_df)} hourly records to {output_file}...")
    out_df.to_csv(output_file, index=False)
    print("Done!")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Prep UCI Dataset into Hourly CSV")
    parser.add_argument("--input", default="household_power_consumption.txt", help="Path to raw UCI dataset")
    parser.add_argument("--output", default="uci_hourly.csv", help="Output path for hourly CSV")
    args = parser.parse_args()
    
    if not os.path.exists(args.input):
        print(f"Error: {args.input} not found! Please check the path.")
    else:
        prep_uci_data(args.input, args.output)
