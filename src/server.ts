import express from 'express';
import exportRoutes from './routes/export';

const app = express();

const port = 3000;

app.get('/', (req, res) => {
  res.send('Hello World!');
});

app.use(express.json({ limit: '50mb' }));

// Export endpoint
app.use('/export/video', exportRoutes);


app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});