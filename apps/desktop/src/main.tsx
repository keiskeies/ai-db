import { createRoot } from 'react-dom/client';
import App from './App';
import { ensureLocaleCatalog, getI18nLocale } from './i18n';
import './styles/app.css';
import './styles/industrial.css';
import './styles/dashboard.css';
import './styles/tools.css';
import './styles/home.css';

const container = document.getElementById('root');
if (!container) throw new Error('root element missing');
// 首屏文案在组件挂载时就定稿，目录必须先在内存里就位。
void ensureLocaleCatalog(getI18nLocale()).finally(() => createRoot(container).render(<App />));
