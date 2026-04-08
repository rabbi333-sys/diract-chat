import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { LanguageProvider } from "@/contexts/LanguageContext";
import Index from "./pages/Index";
import Conversation from "./pages/Conversation";
import OrderDetail from "./pages/OrderDetail";
import Profile from "./pages/Profile";
import InviteAccept from "./pages/InviteAccept";
import ConnectDB from "./pages/ConnectDB";
import NotFound from "./pages/NotFound";
import ProtectedRoute from "./components/ProtectedRoute";
import PermissionRoute from "./components/PermissionRoute";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <LanguageProvider>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <Routes>
          {/* Public: database connection setup — no auth or DB required */}
          <Route path="/connect" element={<ConnectDB />} />

          {/* Public: invite acceptance */}
          <Route path="/invite/:token" element={<InviteAccept />} />

          {/* Protected routes — require active DB connection + auth */}
          <Route path="/" element={
            <ProtectedRoute>
              <Index />
            </ProtectedRoute>
          } />
          <Route path="/profile" element={
            <ProtectedRoute>
              <Profile />
            </ProtectedRoute>
          } />
          <Route path="/conversation/:sessionId" element={
            <ProtectedRoute>
              <PermissionRoute permission="messages">
                <Conversation />
              </PermissionRoute>
            </ProtectedRoute>
          } />
          <Route path="/order/:orderId" element={
            <ProtectedRoute>
              <PermissionRoute permission="orders">
                <OrderDetail />
              </PermissionRoute>
            </ProtectedRoute>
          } />

          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
    </LanguageProvider>
  </QueryClientProvider>
);

export default App;
