const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: CORS_HEADERS,
      body: '',
    };
  }

  const query = event.queryStringParameters || {};
  const params = new URLSearchParams({
    symbol: query.symbol || 'sh000001',
    scale: query.scale || '5',
    datalen: query.datalen || '300',
  });

  const url = `https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?${params.toString()}`;

  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json,text/plain,*/*',
        'User-Agent': 'Mozilla/5.0',
        Referer: 'https://finance.sina.cn/',
      },
    });

    const body = await response.text();

    return {
      statusCode: response.status,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body,
    };
  } catch (error) {
    return {
      statusCode: 502,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        error: 'Failed to fetch Sina K-line data',
        message: error.message,
      }),
    };
  }
}
