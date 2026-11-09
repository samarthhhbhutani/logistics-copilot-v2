import { Route } from 'lucide-react';

export function Brand() {
  return (
    <div className="brand">
      <span className="brandMark">
        <Route size={23} aria-hidden="true" />
      </span>
      <span>
        Logistics<span className="brandSecondLine">Copilot</span>
      </span>
    </div>
  );
}
