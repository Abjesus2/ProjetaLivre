import './styles.css';
import { App } from './ui/app';

const app = new App();
// acesso pelo console do navegador, útil para depuração
(window as unknown as { projetaLivre: App }).projetaLivre = app;
