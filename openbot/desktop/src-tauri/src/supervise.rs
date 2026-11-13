#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_grows_and_then_stops_growing() {
        assert_eq!(backoff(0), Duration::from_secs(1));
        assert_eq!(backoff(1), Duration::from_secs(2));
        assert_eq!(backoff(3), Duration::from_secs(8));
        assert_eq!(
            backoff(10),
            Duration::from_secs(32),
            "an unbounded wait is not a wait"
        );
    }

    #[test]
    fn a_process_that_dies_once_comes_back() {
        let mut watch = Watch::new("server");
        assert!(watch.should_restart(Instant::now()));
    }

    #[test]
    fn a_process_that_will_not_start_is_given_up_on_rather_than_spun() {
        let mut watch = Watch::new("server");
        let now = Instant::now();
        for _ in 0..MAX_RESTARTS {
            assert!(watch.should_restart(now), "should still be trying");
        }
        assert!(
            !watch.should_restart(now),
            "restarting forever turns a fault into a hot laptop"
        );
        assert!(watch.gave_up().contains("server"));
        assert!(
            watch.gave_up().contains("log"),
            "must point at where the reason is"
        );
    }

    #[test]
    fn a_process_that_ran_for_an_hour_is_having_its_first_problem() {
        let mut watch = Watch::new("worker");
        let long_ago = Instant::now() - WINDOW - Duration::from_secs(60);
        watch.restarts = MAX_RESTARTS;
        watch.first_restart = Some(long_ago);

        assert!(
            watch.should_restart(Instant::now()),
            "an old fault should not count against a new one"
        );
        assert_eq!(watch.restarts, 1, "the count starts again");
    }
}
