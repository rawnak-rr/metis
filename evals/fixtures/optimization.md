# Optimization

Gradient descent is a first-order iterative optimization algorithm. It updates parameters in the negative direction of the objective function's gradient.

The learning rate controls the step size. If it is too large, optimization can overshoot or diverge. If it is too small, convergence can be unnecessarily slow.

For a differentiable convex objective, a suitable learning rate supports convergence toward a global minimizer. The gradient norm and objective value are useful convergence diagnostics.

Momentum accumulates a moving average of previous update directions. It can reduce oscillation and accelerate progress along consistent directions.
