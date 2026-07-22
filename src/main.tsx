import {StrictMode, useState} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import {LoginScreen, AdminDashboard, UserDashboard, TOKEN_KEY, ROLE_KEY, Role} from './accounts/AccountsApp.tsx';
import './index.css';

// 🔒 دروازه‌ی ورود کل سایت — هیچ صفحه‌ای (نه ترمینال معاملاتی و نه پنل
// کاربری) بدون لاگین معتبر نمایش داده نمی‌شود. اولین چیزی که هر بازدیدکننده
// می‌بیند، همیشه صفحه‌ی ورود است؛ محتوای واقعی فقط بعد از لاگین موفق
// (بسته به نقش: ادمین یا کاربر عادی) رندر می‌شود.
type View = 'trading' | 'manage-users';

function Root() {
  const [role, setRole] = useState<Role | null>(() =>
    localStorage.getItem(TOKEN_KEY) ? (localStorage.getItem(ROLE_KEY) as Role) : null
  );
  const [view, setView] = useState<View>('trading');

  const logout = () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(ROLE_KEY);
    setRole(null);
    setView('trading');
  };

  if (!role) return <LoginScreen onLoggedIn={setRole} />;

  if (role === 'user') return <UserDashboard onLogout={logout} />;

  // role === 'admin'
  if (view === 'manage-users') {
    return <AdminDashboard onLogout={logout} onOpenTradingDashboard={() => setView('trading')} />;
  }
  return <App onLogout={logout} onManageUsers={() => setView('manage-users')} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
