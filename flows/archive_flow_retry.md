```mermaid
flowchart TD
    A["Retry Failed"] --> B["Load Failed Log"]
    B --> C{"Force Replace?"}
    C -->|No| D["Retry Normally"]
    C -->|Yes| E["Retry with Force Replace"]
    D --> F{"Adjacent Archive?"}
    F --> |Yes| H{"Fresh?"}
    H --> |Yes| L["Skip"]
    H --> |No| M["Replace Archive"]
    F --> |No| K{"Latest Archive Fresh?"}
    K --> |Yes| N["Insert Latest Archive"]
    K --> |No| O["Insert Fresh Archive"]
    E --> G{"Adjacent Archive?"}
    G --> |Yes| I["Replace Archive"]
    G -->|No| J["Insert Archive"]
    M & N & O & I & J --> X{"Success?"}
    X --> |Yes| P["Log Success"]
    X --> |No| Q["Log Failure or Limited"]