import 'dotenv/config'

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  
  jwt: {
    secret: process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production',
    expiresIn: '30d',
    refreshExpiresIn: '90d'
  },
  
  database: {
    url: process.env.DATABASE_URL || 'mongodb://localhost:27017/vcc'
  },
  
  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
    credentials: true
  },
  
  amzKeys: {
    baseUrl: process.env.AMZKEYS_BASE_URL || 'https://ymapi.amzkeys.com:15970',
    appId: process.env.AMZKEYS_APP_ID || '',
    appKey: process.env.AMZKEYS_APP_KEY || '',
    privateKey: process.env.AMZKEYS_PRIVATE_KEY?.replace(/\\n/g, '\n') || '',
    aesKey: process.env.AMZKEYS_AES_KEY || ''
  },
  
  admin: {
    defaultEmail: process.env.ADMIN_EMAIL || 'admin@visacard.com',
    defaultPassword: process.env.ADMIN_PASSWORD || 'admin123456'
  }
}
