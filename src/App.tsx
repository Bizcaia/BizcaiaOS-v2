import { useCallback, useState } from 'react';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import ErrorBoundary from './components/ErrorBoundary';
import { ThemeProvider } from './contexts/ThemeContext';
import BootScreen from './pages/BootScreen';
import OpsApp from './pages/OpsApp';

function initialPhase(): 'boot' | 'app' {
  return typeof window !== 'undefined' && window.location.hash === '#app' ? 'app' : 'boot';
}

function App() {
  const [phase, setPhase] = useState<'boot' | 'app'>(initialPhase);

  const enterApp = useCallback(() => {
    if (window.location.hash !== '#app') {
      window.location.hash = 'app';
    }
    setPhase('app');
  }, []);

  const exitApp = useCallback(() => {
    if (window.location.hash) {
      window.location.hash = '';
    }
    setPhase('boot');
  }, []);

  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <Toaster />
          {phase === 'boot' ? <BootScreen onComplete={enterApp} /> : <OpsApp onExit={exitApp} />}
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
