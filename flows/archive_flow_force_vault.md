```Mermaid
flowchart TD
    A["Force Re-archive All in Vault"] --> B["Apply Path/Word Patterns"]
    B --> C["Apply URL Patterns"]
    C --> D["Always Archive"]
    D --> E{"Adjacent Archive?"}
    E -->|Yes| F["Replace Archive"]
    E -->|No| G["Insert Archive Link"]
    F & G --> I{"Success?"}
    I -->|Yes| J["Log Success"]
    I -->|No| K["Log Failure or Limited"]
    ```