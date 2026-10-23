/**
 * ElectricalGridConditions Data Storage
 *
 * Simplified version - stores grid intensity/forecast data
 * TODO: Wire to proper matterjs cluster server API once defined
 */

export interface GridConditionsData {
  gridCarbonIntensity: number;
  carbonLevel: number;
  region: string;
  time?: number;
}

export interface GridForecastEntry {
  time: number;
  intensity: number;
  carbonLevel: number;
}

/**
 * Simplified EGC data store
 */
export class ElectricalGridConditionsServerBehavior {
  private currentConditions: GridConditionsData | null = null;
  private conditionsForecast: GridForecastEntry[] = [];

  setCurrentConditions(data: GridConditionsData) {
    this.currentConditions = data;
    console.log(`[GridServer] Intensity: ${data.gridCarbonIntensity} gCO2/kWh (level=${data.carbonLevel})`);
  }

  setConditionsForecast(forecast: GridForecastEntry[]) {
    this.conditionsForecast = forecast;
    console.log(`[GridServer] Forecast: ${forecast.length} periods`);
  }

  getCurrentConditions(): GridConditionsData | null {
    return this.currentConditions;
  }

  getForecast(): GridForecastEntry[] {
    return this.conditionsForecast;
  }

  initializeDefaults() {
    if (!this.currentConditions) {
      this.setCurrentConditions({
        gridCarbonIntensity: 150,
        carbonLevel: 2,
        region: "uk",
        time: Math.floor(Date.now() / 1000),
      });
    }

    if (this.conditionsForecast.length === 0) {
      const now = Math.floor(Date.now() / 1000);
      this.setConditionsForecast([
        { time: now, intensity: 150, carbonLevel: 2 },
        { time: now + 3600, intensity: 200, carbonLevel: 3 },
        { time: now + 7200, intensity: 100, carbonLevel: 1 },
      ]);
    }
  }
}
