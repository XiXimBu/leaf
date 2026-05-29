import mongoose from 'mongoose';

export const connect = async (): Promise<void> => {
  // as string | undefined la type assertion cho TypeScript biet du lieu ky vong sau khi doc env.
  const uri = (process.env.MONGOOSE_URL || process.env.MONGO_URI) as string | undefined;
  if (!uri || typeof uri !== 'string') {
    console.error('MongoDB connection string is missing. Set MONGOOSE_URL or MONGO_URI in your environment.');
    return;
  }

  try {
    await mongoose.connect(uri);
    console.log('Connected to MongoDB');
  } catch (error) {
    console.error('Error connecting to MongoDB:', error);
  }
};
