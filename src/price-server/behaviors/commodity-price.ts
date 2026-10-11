/**
 * CommodityPrice Data Storage
 *
 * Simplified version - stores current price/forecast data
 * TODO: Wire to proper matterjs cluster server API once defined
 */

export interface PriceData {
  price: number;
  priceLevel: number;
  currency: number;
  decimals: number;
  tariffUnit: number;
  time?: number;
}

export interface PriceForecastEntry {
  time: number;
  price: number;
  priceLevel: number;
}

/**
 * Simplified CommodityPrice data store
 */
export class CommodityPriceServerBehavior {
  private currentPrice: PriceData | null = null;
  private priceForecast: PriceForecastEntry[] = [];

  setCurrentPrice(data: PriceData) {
    this.currentPrice = data;
    console.log(`[PriceServer] Price: ${data.price} (level=${data.priceLevel})`);
  }

  setPriceForecast(forecast: PriceForecastEntry[]) {
    this.priceForecast = forecast;
    console.log(`[PriceServer] Forecast: ${forecast.length} periods`);
  }

  getCurrentPrice(): PriceData | null {
    return this.currentPrice;
  }

  getForecast(): PriceForecastEntry[] {
    return this.priceForecast;
  }

  initializeDefaults() {
    if (!this.currentPrice) {
      this.setCurrentPrice({
        price: 2500,
        priceLevel: 2,
        currency: 826,
        decimals: 2,
        tariffUnit: 0,
        time: Math.floor(Date.now() / 1000),
      });
    }

    if (this.priceForecast.length === 0) {
      const now = Math.floor(Date.now() / 1000);
      this.setPriceForecast([
        { time: now, price: 2500, priceLevel: 2 },
        { time: now + 3600, price: 3000, priceLevel: 3 },
        { time: now + 7200, price: 2000, priceLevel: 1 },
      ]);
    }
  }
}
