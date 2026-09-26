import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';

const databaseLogger = new Logger('MongoDB');

@Module({
  imports: [
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.getOrThrow<string>('MONGODB_URI'),
        serverSelectionTimeoutMS: config.getOrThrow<number>('MONGO_SERVER_SELECTION_TIMEOUT_MS'),
        maxPoolSize: config.getOrThrow<number>('MONGO_MAX_POOL_SIZE'),
        socketTimeoutMS: 5000,
        autoIndex: config.getOrThrow<string>('NODE_ENV') !== 'production',
        bufferCommands: false,
        retryAttempts: 5,
        retryDelay: 1000,
        onConnectionCreate: (connection: Connection): Connection => {
          connection.on('connected', () => databaseLogger.log('MongoDB connected'));
          connection.on('disconnected', () => databaseLogger.warn('MongoDB disconnected'));
          connection.on('reconnected', () => databaseLogger.log('MongoDB reconnected'));
          connection.on('error', (error: Error) => databaseLogger.error(error.message));
          return connection;
        },
      }),
    }),
  ],
  exports: [MongooseModule],
})
export class DatabaseModule {}
