// The official NJ PBS lockup, shared by the signed-out auth screens and signed-in shell.
export function BrandLockup() {
  return (
    <div className="brand-lockup" role="group" aria-label="Boardwalk">
      <img
        className="brand-image"
        src="/brand/njpbs-horizontal-white.svg"
        alt="NJ PBS"
      />
      <span className="brand-product">Boardwalk</span>
      {import.meta.env.VITE_CMS_DEPLOYMENT_ENVIRONMENT === "development" && (
        <span className="brand-environment" aria-label="Development environment">Development</span>
      )}
    </div>
  );
}
