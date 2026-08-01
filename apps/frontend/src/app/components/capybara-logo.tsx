export default function CapybaraLogo({ className = "" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={`capybara-logo ${className}`}
      fill="none"
      viewBox="0 0 36 36"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle className="capybara-logo-ear" cx="13" cy="7.5" r="2.4" />
      <circle className="capybara-logo-ear" cx="23" cy="7.5" r="2.4" />
      <path
        className="capybara-logo-loop"
        d="M27 8H16C10.5 8 7 11.8 7 17V20C7 25.2 10.5 29 16 29H27"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="3"
      />
      <path
        className="capybara-logo-signal"
        d="M13 25L18 17L23 25M15.5 21H20.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2.5"
      />
      <path
        className="capybara-logo-operator"
        d="M27.5 14.5L31 18L27.5 21.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
      <circle className="capybara-logo-eye" cx="13.5" cy="14" r="1" />
      <circle className="capybara-logo-eye" cx="22.5" cy="14" r="1" />
      <circle className="capybara-logo-node" cx="18" cy="17" r="1.8" />
      <circle className="capybara-logo-node" cx="13" cy="25" r="1.6" />
      <circle className="capybara-logo-node" cx="23" cy="25" r="1.6" />
    </svg>
  );
}
