import { useNavigate } from 'react-router-dom';
import { useTeamRole } from '@/hooks/useTeamRole';
import { ShieldAlert, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface PermissionRouteProps {
  children: React.ReactNode;
  permission: string;
}

const PermissionRoute = ({ children, permission }: PermissionRouteProps) => {
  const navigate = useNavigate();
  const { isAdmin, permissions, loading } = useTeamRole();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 size={24} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  const hasAccess = isAdmin || permissions.includes(permission);

  if (!hasAccess) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <div className="text-center space-y-4">
          <div className="w-14 h-14 rounded-full bg-muted flex items-center justify-center mx-auto">
            <ShieldAlert size={26} className="text-muted-foreground/60" />
          </div>
          <div>
            <p className="text-base font-semibold text-foreground">Not authorized</p>
            <p className="text-sm text-muted-foreground mt-1">
              You don't have permission to view this section.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => navigate('/')}>
            ← Back to Dashboard
          </Button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
};

export default PermissionRoute;
