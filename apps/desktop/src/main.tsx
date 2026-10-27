import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/app.css';
import './styles/industrial.css';
import './styles/dashboard.css';
import './styles/tools.css';

const container = document.getElementById('root');
if (!container) throw new Error('root element missing');
createRoot(container).render(<App />);
